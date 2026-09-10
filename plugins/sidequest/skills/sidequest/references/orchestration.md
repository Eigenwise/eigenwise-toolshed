# Orchestration: fan-out and agent teams

Read this when you're about to run more than a couple of executors at once or when agent teams is on. The baseline
delegation rule (gather enough evidence with read-only tools or native `Explore`, write precise tickets,
route implementation by default, batch small same-model tickets, and fan out over independent waves) lives
in the main skill — this file is the detail on the bigger shapes.

## Improvement authority

The orchestrator decides whether an improvement is worth making, its concrete benefit, the approach, and
boundaries before implementation dispatches. Research tickets gather facts and bounded alternatives; the
orchestrator evaluates them and pins the decision. Executors implement that decision with ordinary local coding
judgment. They report concrete contradictory evidence instead of silently choosing a new agenda, architecture, or
scope. Unknown facts earn focused research only when they could change the decision; unrequested optimizations do
not create an investigation by default.

## Decomposition in depth

### Solo-fit gate before decomposition

Apply the inline-safe gate before solo-fit or ticket filing. A user-directed mechanical edit to one or two named files with stated content, including an exact one-line `.gitignore` entry, is inline work: edit it directly, do not file a ticket or spawn an executor.

Before filing several tickets, use solo-fit only to choose the dispatch shape. **SOLO-FIT picks
one-executor vs wave; it NEVER means you implement inline.** File **one ticket and dispatch one
executor** for small coherent work. A combined ticket is only for exactly one request item or items
provably one defect.

When a multi-item contract cannot be pinned, file a concurrent read-only investigation wave: **one
investigation ticket per independent item**, categorized as `codebase-exploration`, `debugging`, or
`spike-investigation` with `readonly: true`. Each returns a compressed root cause with file:line, proposed fix, verify command,
and defect status. The orchestrator then pins separate fix contracts from the findings. In isolated
worktrees, dispatch those fixes in parallel. In a shared-tree project (including Docker mounts of the
checkout), different-file fixes still get separate tickets but dispatch serially or batched into one
executor; shared-tree writes are the only reason a fix wave serializes. A one-item unpinnable claim
still needs a completed exploration/planning ticket naming the interface that resisted a written
contract, or no written contract surface in the request. “Feels coupled” is not evidence: when unsure,
file the short planning ticket first.

**Maximize the ready set.** Decompose to maximize the ready set: prefer cuts along disjoint surfaces so more tickets can dispatch together. A cut that forces a serial chain needs a stated reason. In isolated worktrees, same-file overlap alone is not a conflict. A shared runtime resource serializes writes and live reproduction, never read-only investigation; otherwise dispatch in parallel and resolve the rare merge conflict at integration.

Example: three PR review comments in three files → three read-only investigation tickets in one wave →
the orchestrator pins per-comment fix contracts from the findings → fix wave (parallel in worktrees,
batched in a shared tree) → one merged-tree gate.

After solo-fit chooses wave mode, file the complete planned backlog before dispatching: every planned
ticket for every wave, each with declared files, dependency links, and per-ticket verify. Then dispatch
the entire ready wave in parallel. Filing one ticket, dispatching, waiting, then filing the next
serializes work and hides the plan until the user cannot steer it. Later discoveries still become normal
mid-run tickets.

Wave mode files its complete backlog under a story. A planning investigation can pin shared decisions and
anchors before a wave starts. Put frozen orchestrator decisions, invariants, acceptance evidence, and
durable artifact links in the story execution contract once (`story contract US-n --body-file path` or
MCP `story_contract`) rather than repeating them in steering messages. Durable contract storage is capped at 256 KiB UTF-8; MCP reads retrieve it in 16 KiB UTF-8-safe pages with revision, SHA-256, total bytes, and a cursor. The contract arrives before ticket scope in every member briefing. The `story log` is the executor-to-executor
channel for live cross-ticket discoveries; at integration, the orchestrator promotes durable entries into
the contract, then clears the log. If the contract changes after a member is claimed, `pulse`/`changes` and the next dispatch warn
about revision drift. This keeps context completeness cheap without the orchestrator rediscovering the
codebase inline.

### Shared working-tree deliveries

A live sibling allocation is excluded only when both shared-tree working-tree dispatches record the same nonempty preparing session, their claims overlap, and their scopes are disjoint. Before dirty-path classification, Sidequest validates every eligible completed sibling's recorded candidate against its recorded paths and current content. A mismatch refuses closeout: preserve the shared-tree work and hand it back to the existing parent for verification or grooming. Do not revert it or expand scope to absorb it.

Before dispatching a wave, ask: “What will every ticket in this wave need to change that none of them owns?” For each shared file or seam, pin its shape in the story execution contract before dispatch, or file one prerequisite ticket that the wave depends on. Do not reformat regions you did not functionally change in shared files; a prettier pass over a file three peers are editing can turn five-line changes into unmergeable successors.

When a package commits build output, the source ticket scopes its generated output too. For content-hashed output, assign exactly one rebuild ticket per wave: parallel rebuilds choose different filenames and collide at merge.

**The planning pass is for concrete scope, not ceremony.** Before filing a complexity-4+ ticket,
bounded recon may `Read`/`Glob`/`Grep` named anchors and make one narrow location sweep. Route unfamiliar
path tracing, deep investigation, or multi-angle research through the live taxonomy, with a proportional
ticket that pins the scope, executor anchors, and exact verify command before implementation tickets are
filed. For a wave ticket, make that verify command a
scoped test or reproduction for its declared files; reserve full-suite green for the integration or
ship ticket. Shrink until the complexity drops — a piece still scoring 7+ is usually a small design
ticket plus a mechanical application ticket.

**Ticket detail follows the decision and remaining uncertainty.** Every ticket needs the selected outcome,
anchors, expected behavior, boundaries, and precise verification commands needed to implement the pinned plan.
If finishing would need facts the contract does not carry, gather only the facts that could change the decision,
then add them to the spec or split the work further.

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
  Audit when the work has no deterministic done-oracle, a weak oracle leaves material uncertainty, or
  high-stakes flags demand independent scrutiny. The integrator consumes the submission report and gate
  evidence; it does not inspect the implementation diff.
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

When an executor needs an undeclared path, it calls `scope-request <ref> --file <path>`. A concrete path in the same declared package surface, such as `src` or `lib`, is added immediately and recorded as an audited auto-approval. Test roots and mechanically derived build outputs use the same no-pause path. A sibling package surface, another package or plugin, wildcards, read-only work, CI and Claude control files, credentials, and release machinery stay pending for a ruling with the claim intact. Verification evidence never needs repository scope: the dispatch briefing names its board-owned evidence directory for screenshots, HTML dumps, and probe output. Reference that directory from the ticket record instead of writing evidence into a worktree or integration target. A pending request records only the uncovered additions and prints the authoritative `sidequest update <ref> --files ...` approval command. Run that exact update to approve the full request, then resume the same executor. A plain `update --files` is also authoritative only when its resulting scope covers every pending requested path; otherwise Sidequest reports the request is still pending and prints the full command. Scope lint still rejects out-of-scope commits and submissions. Do not release and redispatch a healthy executor just to add a path.

## Fan-out mechanics

When several tickets are **ready and independent**, work them in parallel — one executor per ticket,
all spawned in a **single message** (true parallel). This is safe precisely because claiming is
atomic: each subagent claims a different ticket, and any race just sends the loser onward.

- **Never invent a worker name.** Full-schema `dispatch` returns `spawn.name` built from the board:
  ticket ref, a short title slug, resolved route token, and effort (`sq-843-release-engine-terra-high`).
  A relaunch keeps that route then counts up (`-2`, `-3`) so a reworked or resumed launch never shadows a live sibling. That label is what shows
  in the fleet view (filter `a:<name>`) and what `SendMessage {to: name}` resumes; the board retains it even when a reduced-schema spawn omits
  callable `name` and `mode`. Opt into reduced schema only after inspecting the visible Agent tool schema, pass its returned fields unchanged, and
  require hook-reported `agent_id` plus `permission_mode: "bypassPermissions"` on first claim. `spawn.description` still leads with `<model>, <effort> ·`
  for notifications and stop lines.
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
- **Workers record operational state in the canonical closeout payload.** The orchestrator owns wave admission and shared-resource
  coordination; each worker owns its ticket. A submission's `body` carries the report, while its automatic terminal marker stays short. A `done` completion comment carries the report directly. Record conflicts found,
  server lifecycle (started, reused, or stopped), files changed, blockers, cleanup performed, and
  verification output there. Tickets with no declared scope never mechanically conflict, so eyeball whether
  they'd edit the same files before parallelizing them.
- **Integrate and verify by wave.** Each executor runs its scoped verification before submission.
  When the quiet wave lands, read each submit report, then run one combined full gate for the wave. On
  green, integrate. The oracle is the review: never open source or inspect diffs to re-review executor
  work. When a named safety-sensitive seam needs independent scrutiny, dispatch a `review-audit` for that
  seam; do not turn the orchestrator into the reviewer.
- **Executor prompts stay lean and cannot narrow the ticket**: add only the ref, worker id, claim/done commands, stamped effort/model, and logistics the ticket does not carry. The ticket contract is authoritative and must travel in full, unchanged scope. If the plan changed, update the ticket before dispatching. **Anti-pattern: dispatch narrower than ticket.** In a sample ticket, the ticket required extracting the done block across every lesson route and two commits, while the dispatch limited work to intervals as a reference. The executor bounced correctly, then the orchestrator had to re-plan. Never create that contradiction.
- **Read bounded briefing comments from the newest end.** A brief can carry a compact newest-first comment packet instead of the full thread. Read compact `comments` pages first, following their cursor only when needed. Read the full chronological thread only when the brief flags a decision or constraint in omitted history; otherwise the latest packet and compact pages carry the current handoff.
- **Resume Continuation checkpoints with a fresh dispatch.** Executors create a Continuation checkpoint around 100 tool rounds by committing verified declared-scope work, writing a `Continuation checkpoint` comment with the commit, files touched, next steps, and verification state, then releasing to `todo`. On a natural wakeup, use `pulse` and the latest comment to confirm that header, commit, and no live claim. Read the checkpoint before `dispatch <ref>`, then spawn its returned continuation unchanged so it gets a fresh token and context. The dispatch validates the registered retained worktree against the repository before carrying it forward, replays a retained checkpoint onto an advanced integration target, and reports its exact Git validation evidence if it must fall back. A rebase conflict stops the executor for escalation, without resetting the retained checkpoint or resolving toward either side. A live claim means the checkpoint has not completed, so do not launch beside it; use the normal salvage path if that worker stopped.
- **Record wave links from board results.** Never write an `SQ-n` ref you did not read back from a board response. File related tickets first, collect their returned refs, then use `update` or, preferably, `link` (`blocks`, `depends-on`, or `related`) to record relationships. Links are board data, so they stay correct without prose cross-references.
- **Read liveness from the board, not notifications.** Notifications wake the orchestrator but do not prove executor state. An idle notification can describe a working, dead, or already-finished executor, so read board truth before acting: use `pulse <ref>` for the ticket's `{claim:{by,at,ageMs}|null, comments, lastComment, git:{commit,dirty}|null}` state. Until `pulse` is available, read claim age, comments, and `git log`. If several tickets need checking, use `changes --since <iso>` for the `{tickets:[...]}` delta, sorted oldest first.
- **Read completion from the board.** An executor stop notification wakes the orchestrator; its terminal
  submit or done state is the completion signal. Do not expect or request a routine
  `SendMessage` report. Read a submission's canonical report body or a done completion comment for what changed, verification evidence, commit hash or
  close confirmation, and anything deliberately skipped. `SendMessage` remains for blockers,
  `kind=question` needs, scope conflicts, and failures the board cannot express.
- **Recover a dormant completion.** A task-completed notification with no submission or terminal board state while its claim is live means the executor is dormant, not finished. `pulse`; if dispatch is still claimed and fresh, `SendMessage` the same named agent to continue, keeping its claim, token-file path, and recorded worktree binding. If that resumed executor gets `matches no dispatch record` from the write hook, it keeps the claim and calls MCP `dispatch` once with `ref`, `recoveryEvidence`, `claimHolder` (the exact claim `by`), and the linked `worktree` path. The board verifies the stored executor, re-mints the token, and re-binds the worktree without a release. A silent worker is dead only when the board and task evidence confirm terminal death: salvage, release, fresh-dispatch, then spawn one replacement. Never respawn beside a live claim or `TaskStop` without terminal board evidence.
- **Correct the live worker before replacing it.** When a claimed executor has useful edits, a scoped commit, or meaningful verification and its concern is interpretive or correctness-related, read the evidence it recorded and send the corrected evidence or decision to its board-derived name with `SendMessage`. Keep the claim and its worktree alive so that executor can correct and reverify. A fresh dispatch is only for confirmed terminal death, an intentional Continuation checkpoint, or a genuine blocker with no salvageable work.
- **Salvage before redispatch.** When a worker is dead or stopped, inspect its worktree before releasing or
  replacing it. If an isolated worker's recorded worktree is gone, do not `SendMessage` it: redispatch after
  reading the ticket instead, because a resumed agent must never fall back to the shared checkout. Preserve a
  verified commit, or recover the declared-scope diff, then read the ticket and its thread again before deciding
  whether a replacement is needed. Never overwrite stranded work by blindly redispatching. Use `sidequest worktrees status` to check the disk use of active worktrees, recovery backups, and quarantine. Use `sidequest worktrees sweep --dry-run` to review old executor worktrees and recovery entries; it only removes worktrees that are clean, at least three hours old, and whose commits are patch-equivalent to
  `origin/main`. Sweep, reclaim, and failed-creation recovery never follow a dependency link. Before removal, each unlinks only a Sidequest-created link whose recorded normalized path, expected target, and checkout identity still match; missing, foreign, unreadable, or changed links remain protected as `dependency_link_untrusted`. The dry run also names expired backups and quarantine entries, which default to 14 days and three per agent. Pass `--yes` only after reviewing the list. When a natural wakeup shows that an executor has no claim and no commit past the
  2–3 minute grace period, stop it, then diagnose before retrying: `pulse <ref>` and read the denial or
  terminal reason verbatim. Make ONE retry only when that diagnosis changes the dispatch; never blindly
  respawn the identical spec. When native Agent reports the exact supported Claude quota-limit signature before claim, the failure hook records that primary attempt
  and prepares the ticket's configured fallback with a fresh token. Run `dispatch` for the ref again, then
  spawn the returned fallback spec unchanged. Do not edit or detach the category: the recovered route is
  ticket-local, survives a session restart, and normal category policy resumes when that dispatch ends.
  Treat any other model-access or API error as generic. Surface it without guessing a fallback or retrying
  the route. Never message a dormant executor and spawn its replacement together: confirm terminal death,
  then release before replacing it. A dispatch failure needs verbatim ticket evidence and user-visible
  escalation; never pull substantial work inline by default. Other `SendMessage` calls
  carry new information such as a scope change or unblock, never a "wake up" poke.
- **Retire an attempt no runtime will finish.** Two shapes qualify. When `pulse` reports the dispatch
  `prepared` or `launched` with no bound runtime identity, no claim, and no checkpoint, there is nothing to
  wait for: the spawn never started or never bound. And when it reports `stalled` with "bound a runtime that
  never claimed, past the claim-idle backstop", that runtime is gone: a claim is a bound executor's FIRST
  action, and its stop hook never fired, so nothing else will ever retire the attempt. Retire either in one
  call with `sidequest dispatch <ref> --recovery-evidence "<observed failure evidence>"` (MCP
  `recoveryEvidence`). A tokened claim refused as `prepared_compatibility_stale` is already terminal: that
  refusal retires its own stale attempt, so the executor stops without claiming and the orchestrator dispatches
  a fresh token. That records the evidence on the failed attempt, keeps it in `dispatch.attempts` as
  history, and prepares exactly one fresh identity. It refuses while a bound attempt is still inside the
  backstop, and once the attempt is checkpointed or terminal; the refusal names which of those it
  found and, for a bound one, how long is left. A claimed executor that is provably dead goes through claim
  release or `groomClose --recoveryEvidence`. The exception is a live claimed executor that resumed into its
  original linked checkout but lost only the board binding: it uses `dispatch` with `recoveryEvidence`,
  `claimHolder`, and `worktree`; the board verifies the stored executor and restores that same identity without releasing.
- **A submitted ticket is not dispatchable.** While a submission is pending, the ticket is parked for the
  publish transaction, and a claim on it is refused as `submitted`, so dispatching would mint a token nobody
  can claim. Preparation refuses there and names the three exits: integrate it, `rework` it (which clears the
  submission, and is the path when you want a replacement executor), or `groomClose --abandonSubmission` with
  evidence it never landed. Resolve the submission first, then dispatch.
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
  token spend of plain subagents, so answer executor questions promptly and retire terminal teammates
  only after consuming board evidence. After spawning, end the
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
- **Retire terminal teammates.** Once terminal board evidence has been consumed and its submission report,
  done comment, or recovery handoff has been preserved, call `TaskStop({ task_id: "<agent name>" })` once for
  that exact native teammate. This is a Claude Code host action, not a Sidequest tool. It applies to submitted,
  done, released, failed-before-claim, and superseded attempts. Never stop a live claim, retained continuation,
  or candidate awaiting integration. Do not wake a completed executor, poll FleetView, or create a cleanup loop.
  A `READY_FOR_INTEGRATION` verdict additionally queues the ticket for the publish transaction
  ([publishing.md](publishing.md)) — publish the wave's submissions in one batch; never respawn an executor for a
  submitted ticket. Sweep ALL finished executors, not just the one that notified, so session exit only stops live work.

- **Reports stay terse:** a submission body carries the canonical full report and its automatic terminal marker stays short; a `done` completion comment carries its report directly. A repo-changing executor records a SUBMITTED commit, never a push — the orchestrator's publish transaction is what makes it reachable from `origin/main`, and the ticket goes done only after that reachability check passes.

- Parallelism costs tokens and orchestration overhead — a couple of parallel investigations or an
  executor wave where sizes justify it, not a swarm for everything.

## Worktree base selection

For an isolated repository dispatch, a configured `worktreeBase` of `local-main` or `origin-main` selects that base for read-only and writer tickets alike. `auto` intentionally keeps a read-only ticket on the checkout that prepared it; writers retain automatic integration-target selection. An explicit local or remote dispatch target overrides the board setting. Shared-tree artifacts and non-repository output stay on the current tree. A bound Git review candidate overrides every configured or explicit integration target.

## Bookend supervision

After dispatch, leave a ticket alone until it submits: no pulse, comment read, worktree peek, or proxy
waiting. At integration, read the submit report and run the one combined full gate for the wave, then
integrate on green. The executable oracle is the review, so do not open source or inspect diffs to
re-review executor work. File a separately routed `review-audit` only when the contract names a
safety-sensitive seam the oracle cannot exercise.

### Candidate-addressed review binding

File the `review-audit` ticket with `reviewTarget`: the reviewed ticket's ref plus the exact submitted
candidate (`commit`, or `sourceRevision` for a non-Git artifact). `add` and `update` are the only ways to
set it, and the store writes the review's `reviewTarget` and the source's `submission.review` mirror in one
transaction, so a failure between them leaves neither. The source must be claim-free with a terminal
submission whose candidate matches exactly; a live claim, a stale commit, or a candidate another review
already owns is refused. The binding is immutable: no generic patch sets, changes, or clears it, retarget
needs a fresh review ticket, and a category move away from `review-audit` is refused.

Binding freezes the candidate. Reclaim, amendment, `clearSubmission`, and supersede all fail closed on the
source, including a legacy one-sided binding, so the implementer cannot resume or amend the revision under
audit. Dispatch revalidates the binding and pins the review to that exact immutable commit in an isolated
checkout: the baseline is the candidate rather than the integration branch, and the briefing tells the
reviewer to detach onto it before any review work, then stop and report if it is unreachable rather than
reviewing whatever commit its worktree happened to start on. A shared-tree request and a native-agent spawn
are both refused. A review also ENDS on its candidate: a terminal `done` reads the review checkout's own
revision and is refused as `review_tree_mismatch` when it sits on anything else, naming the observed
revision, the candidate, and the `git -C <worktree> checkout --detach <candidate>` repair, and as
`review_tree_unobservable` when the checkout cannot be read at all, which releases as a technical blocker
and dispatches again. Integration waits for the bound review to reach a terminal `done`, including an accepted oracle closeout for a readonly review. Close that case with exactly `verdict({ ref, outcome: "accepted", text, why })`; it stores `text` as the completion comment and changes the review to `done`. Integration reads both identities from immutable terminal dispatch attempts rather than the live dispatch record: the source's `submitted` attempt for that exact commit and the review's `done` attempt, or the terminal `released` attempt accepted by that oracle closeout. A missing identity on either side, the same agent id on both, or a later prepared dispatch leaves integration blocked with `candidate_review_required`.

No caller-controlled route rejects a bound candidate. `rework`, `recordSubmissionRejection`, raw MCP `rework`, CLI `rework`, and
reconciliation of a matching pending rejection all return one pre-write `candidate_review_locked` refusal,
whatever `by` or `reviewRef` claims, because MCP hands a handler nothing but caller-supplied JSON and no
argument can prove an external release principal. A review that finds a defect records its evidence on the review ticket and releases that review with `kind=oracle`. When the oracle accepts the defect conclusion, Sidequest records `rejected` on both binding halves; if it rejects that conclusion, it records `accepted` and closes a readonly review through `verdict({ ref, outcome: "accepted", text, why })`.
The source stays pending until a fresh repair is dispatched, reviewed, and integrated, then
`supersede_submission` closes the oracle-rejected source against that repair. `rework` still bounces an
UNBOUND candidate back to `todo` for its owner.

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

## Orchestration load: keep the lead responsive

Delegation follows the pinned plan and ticket boundaries, not relative model price or capability. The
orchestrator decides what implementation to dispatch before routing it; an executor does not pull the work back
inline or choose a different improvement to reduce wakeups. Cost can shape the execution of that selected plan,
such as how a wave is batched, but it does not choose product decisions or tradeoffs.

The load to manage is the lead's own wakeups and context size. Each time a worker finishes and hands control
back, the lead resumes and re-reads its context to react. Prompt caching softens the per-token price of those
re-reads but does not remove them: reading a large context repeatedly still adds up.

The lead has two kinds of turn: routing/ack and plan/synthesis (decompose, weigh reports, write the
spec, integrate). Keep the plan and the execution route separate: route choice does not transfer product or
tradeoff authority to an executor. You can reduce wakeup load without giving up steering by keeping the context
lean first. Batching synchronously trades control for fewer wakeups and stays optional.

- **Keep the lead context lean.** Do not pull full executor reports into the planning thread unless a
  synthesis step genuinely needs them. Read the ticket comment or artifact by reference when needed, so raw output
  does not become permanent weight on later wakeups.
- **Batch only when the selected work needs little steering.** A synchronous wave reduces wakeups but is blind
  until it ends. Use it for tight, verify-gated tickets, never as a way to avoid choosing or steering the plan.
  Agent teams stays background and steerable regardless of `run_in_background: false`.

## Discovery and research

Default to fanning understanding out when it will help, while using read-only tools or native `Explore` to
gather enough evidence for precise ticket boundaries. A known file or one-step lookup can stay inline, and
an unfamiliar subsystem can become a `codebase-exploration` spike when that gives the implementation wave
a better brief. Spikes that must execute modified code: set `readonly:false` at filing time, don't recategorize. `Explore`, `claude-code-guide`, and `statusline-setup` are narrow harness utilities that may
run without a prepared Sidequest dispatch, but `Explore` is a quick evidence sweep, not an investigation
route: it inherits the session model, and on a routed board the third Explore spawn without any board
interaction is refused, as is any Explore relaunch of work a generic Agent was already denied for. Deep or
fan-out investigation is a `codebase-exploration` spike. Other delegated implementation, research, review,
or domain analysis needs a ticketed route; its concise findings inform the next ticket boundaries. Workflow agents
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
its returned stable per-model `agent` and `spawn` object immediately. Pass every `spawn` field
unchanged: `Agent.description === spawn.description` byte-for-byte. Do not derive it from
`spawn.prompt`, its route marker, ticket title, model, or effort. `spawn.prompt`
stays a compact fetch stub with only the claim reference, token,
board identity, and route marker. The executor's token-gated first action fetches the durable packet:
full description, category contract and route, anchors, verify command, declared files, labels,
priority, story and dependency state, every chronological comment, and every attachment as an absolute
path. It inspects every readable attachment and reports missing or unreadable paths before implementation.
Stable executors are
ready from session start. Claude routes pass `model: exec.model`; Codex routes
omit `model`: the shared `sidequest-exec-dispatch` def, or `sidequest-exec-dispatch-readonly` for a readonly
category, pins the virtual `claude-codex-auto`,
and `spawn.prompt` ends with `[sidequest-route model=... effort=...]`, which tells the codex-gateway shim which real
model and effort to run, so pass the prompt verbatim, never write another such line, and never batch tickets
stamped with different models into one spawn. The gateway route log records both values per dispatch; a marker effort that differs from the board stamp in an audit means the prompt was hand-edited. Claude builtins are provisioned at all five effort
levels; Codex dispatch is one read-write def and one readonly def, because the route marker carries the
effort. Route edits change only board data; the executor def set
is fixed, so nothing is written or registered when a route changes. The executor claims with the
returned token and exact stable executor name.

Cross-session adoption is a fresh `dispatch <ref>` in the adopting session. It rotates
the token and returns the current spawn for the same stable route. A retained-worktree continuation
omits `spawn.isolation`, so the executor starts from its caller context and works the retained worktree by
absolute path, with `git -C <retained>`. It does not call `EnterWorktree`, which only accepts worktrees
under `<repo>/.claude/worktrees` and can never reach a board-retained one. Ordinary isolated dispatches
still return `isolation: 'worktree'`.

Re-dispatch rotates the token while the stable executor name remains fixed. A stale token is refused,
and `done` or `release` clears the dispatch guard for either mode. An Agent acknowledgement means only
`launched`. Pulse the ticket immediately and report it as running only after the holder and dispatch
token are visible. A denied or missing claim requires diagnose-first evidence: pulse and read the denial
verbatim, then retry only when that diagnosis changes the dispatch. Never issue an identical blind respawn;
ticket evidence and a user-visible escalation are required before any further recovery. Never trust a worker's self-reported identity. The token-gated claim and the dispatch response are the evidence.

## Routed Agent dispatch

All routed execution stays in the current conversation. Call `dispatch <ref>` through the CLI or MCP,
then pass its exact stable executor and complete `spawn` object unchanged to Agent. Set
`Agent.description` from `spawn.description` byte-for-byte. It is the human FleetView subtitle;
never substitute text from the prompt, route marker, title, model, or effort. The
executor claims using the returned token, its exact executor name, and the stamped effort. The claim guard
is the proof that the right route ran. For Codex, preserve `spawn.prompt`'s route marker unchanged so the
gateway receives the resolved model and effort; never add, rewrite, or combine markers. Dispatch is the
current board interface for routed work.
