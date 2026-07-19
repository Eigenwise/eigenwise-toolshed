# Orchestration: fan-out and agent teams

Read this when you're about to run more than a couple of executors at once or when agent teams is on. The baseline
delegation rule (route execution down to each ticket's stamped cheap model as short bounded runs,
batch small same-model tickets, fan out over independent waves, inline only trivial one-steps) lives
in the main skill — this file is the detail on the bigger shapes.

## Fan-out mechanics

When several tickets are **ready and independent**, work them in parallel — one executor per ticket,
all spawned in a **single message** (true parallel). This is safe precisely because claiming is
atomic: each subagent claims a different ticket, and any race just sends the loser onward.

- **Name every worker.** Each concurrent executor gets a unique `name` (lowercase-hyphens, e.g.
  `exec-sq12`). Naming makes it addressable: it shows in the fleet view (filter `a:<name>`) and is
  resumable via `SendMessage {to: name}` with its history intact. Every Agent launch must be a freshly
  dispatched Sidequest executor.
- **Tie the `name` to the `--by` id** — both unique and session-scoped for the same worker, so the
  agent is addressable and its board activity is stamped by the same identity. The `--by` must be
  genuinely random per session (not the ticket ref, not a fixed label): a second session fanning out
  over the same board would derive the identical value and silently coexist as the same worker.
- **One wave at a time.** `ready --json --brief` partitions the set into parallel-safe waves by
  declared file scope — no two tickets in a wave overlap. Before spawning a wave, assess the runtime
  resources each ticket needs: fixed ports, domains, shared databases, existing servers, and files
  outside the declared scopes. Worktrees isolate files, not those resources. Serialize tickets that
  share one, and name the orchestrator/worker ownership before launch. Spawn wave 1, wait, re-run
  `ready`, repeat.
- **Workers report operational state.** The orchestrator owns wave admission and shared-resource
  coordination; each worker owns its ticket. Worker reports must say conflicts found, server lifecycle
  (started, reused, or stopped), files changed, blockers, cleanup performed, and verification output.
  Tickets with no declared scope never mechanically conflict, so eyeball whether they'd edit the same
  files before parallelizing them.
- **Review seams once after a wave closes.** At the next natural wakeup, inspect one combined diff/stat
  for the wave and only its cross-ticket seams: overlapping edits, shared interfaces/contracts, duplicate
  implementations, and incompatible assumptions. If none exists, proceed without a broad review. If one
  does, file a narrowly scoped review-audit follow-up for the affected files; do not reopen completed
  tickets or rerun every ticket's verification. Keep this a short event-driven inspection, not a second
  review pass.
- **Executor prompts stay lean and cannot narrow the ticket**: add only the ref, worker id, claim/done commands, stamped effort/model, and logistics the ticket does not carry. The ticket contract is authoritative and must travel in full, unchanged scope. If the plan changed, update the ticket before dispatching. **Anti-pattern: dispatch narrower than ticket.** In Cantizans SQ-87, the ticket required extracting the done block across every lesson route and two commits, while the dispatch limited work to intervals as a reference. The executor bounced correctly, then the orchestrator had to re-plan. Never create that contradiction.
- **Record wave links from board results.** Never write an `SQ-n` ref you did not read back from a board response. File related tickets first, collect their returned refs, then use `update` or, preferably, `link` (`blocks`, `depends-on`, or `related`) to record relationships. Links are board data, so they stay correct without prose cross-references.
- **Read liveness from the board, not notifications.** Notifications wake the orchestrator but do not prove executor state. An idle notification can describe a working, dead, or already-finished executor, so read board truth before acting: use `pulse <ref>` for the ticket's `{claim:{by,at,ageMs}|null, comments, lastComment, git:{commit,dirty}|null}` state. Until `pulse` is available, read claim age, comments, and `git log`. If several tickets need checking, use `changes --since <iso>` for the `{tickets:[...]}` delta, sorted oldest first.
- **Salvage before redispatch.** When a worker is dead or stopped, inspect its worktree before releasing or
  replacing it. Preserve a verified commit, or recover the declared-scope diff, then read the ticket and
  its thread again before deciding whether a replacement is needed. Never overwrite stranded work by
  blindly redispatching. When a natural wakeup shows that an executor has no claim and no commit past the
  2–3 minute grace period, stop it and respawn it once with the same briefing. If a Claude-routed executor
  dies immediately with a model-access or API error, do not respawn that route: its model likely left the
  plan. Flip the category route to its recorded fallback with one category edit, then redispatch. Never
  both message the old executor and spawn a replacement for one ticket. A respawn that still produces no
  claim is a user-visible failure: surface it, do not try a third spawn, and do not pull substantial work
  inline by default. `SendMessage` is for new information such as a scope change or unblock, never a
  "wake up" poke.
- **A 32 MB launch failure is not a retry.** When a dispatched native Agent dies before its first model
  turn with `Request too large (max 32MB)`, it is a non-retryable 413 from the orchestrator's accumulated
  images or attachments, not the ticket or briefing. Do not blindly redispatch or resume it: a fresh Agent
  inherits the oversized parent request and fails the same way, while a resume only grows it. If it claimed
  the ticket, run `release --status todo` first. It did no file work, so there is no worktree to salvage,
  though the salvage rule above still governs any partial commit. Recover by running `/compact` in the
  orchestrator's own session, which drops accumulated attachments, or use Esc twice to remove the turn that
  added them, then redispatch once. If that fails too, start a new top-level session with only the concise
  task and filesystem paths. Surface the failure after that one compact-and-redispatch attempt.
- **Use steerable background execution by default.** Executors are background teammates, so `TaskOutput`
  cannot resolve their names (`No task found`) and polling is banned regardless. After spawning, end the
  turn. Its stop notification is the only wakeup. On the next natural wakeup, whether a stop notification,
  user message, or other task notification, make opportunistic liveness checks for work that has run about
  5–8 minutes or longer. Never hold a session open with foreground or background `sleep`, blocking
  `TaskOutput` as a delay, or busy-wait loops. A turn with nothing to do ends. At every wakeup, diff board
  state with `changes --since <iso>` before deciding what to do next. Use synchronous execution only for a
  tight wave where blindness is acceptable.
- **Clear verified workers.** An executor stop notification is a cleanup trigger: pulse the ticket, verify its done or submission comment, board state, and git result, then call `TaskStop` in one motion. A `READY_FOR_INTEGRATION` verdict additionally queues the ticket for the publish transaction ([publishing.md](publishing.md)) — publish the wave's submissions in one batch; never respawn an executor for a submitted ticket. Executors deliberately kept alive mid-ticket get the same treatment at their next natural wakeup. Sweep ALL finished executors, not just the one that notified, so session exit only stops live work.

- **Reports stay terse:** what changed, files/lines, verification output, and close confirmation. A repo-changing executor reports a SUBMITTED commit, never a push — the orchestrator's publish transaction is what makes it reachable from `origin/main`, and the ticket goes done only after that reachability check passes.

- Parallelism costs tokens and orchestration overhead — a couple of parallel investigations or an
  executor wave where sizes justify it, not a swarm for everything.

## Natural orchestrator checkpoints

At every natural wakeup, do a short self-check before launching more work. Check payload and context bloat
(first trim raw reports or reopen only the ticket comments you need), lingering workers (pulse and clear
finished workers), route anomalies (the fresh ticket `exec` object, claim token, executor, effort, and
unchanged dispatch briefing), and board hygiene (stale claims, submitted tickets, unanswered questions,
and blocked work). These are event-driven checks, not a polling loop. File or release the smallest
follow-up when something is off; do not let the main thread silently accumulate dead workers or stale
board state.

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

For a codebase you already know, or a task whose files you can name, use direct `Read`, `Glob`, `Grep`, or
`WebFetch` inline. Any delegated exploration, research, review, or domain analysis requires a ticket first;
route and dispatch it, then spawn the returned executor. Its comment supplies concise findings that inform the
next ticket boundaries. Workflow agents remain governed by their Workflow contract.

## Agent teams (CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS)

With agent teams on (a **per-user** flag), parallel workers spawn as manageable teammates. The routing
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
its returned stable per-model `agent` and `spawn` object immediately. Pass the returned `briefing`
unchanged as the Agent prompt. The briefing carries the full ticket contract, category contract,
anchors, verify command, comments digest, and token-gated claim guard. There is no watcher-registration
announcement or registration wait in this path. Claude routes pass `model: exec.model`; Codex routes
omit `model`: the shared `sidequest-exec-dispatch-<effort>` def pins the virtual `claude-codex-auto`,
and the briefing's closing `[sidequest-route model=... effort=...]` line tells the codex-gateway shim which real
model and effort to run — pass the briefing verbatim, never write another such line, and never batch tickets
stamped with different models into one spawn. The gateway route log records both values per dispatch; a marker effort that differs from the board stamp in an audit means the prompt was hand-edited. All five effort levels for both Claude builtins and Codex
dispatch are always provisioned. Route edits change only board data; the executor def set
is fixed, so nothing is written or registered when a route changes. The executor claims with the
returned token and exact stable executor name.

Use `dispatch <ref> --ephemeral` (or `{ephemeral:true}` in MCP) only for cross-session adoption. That
opt-in path creates a self-contained per-ticket executor definition that another session can pick up,
but it costs the watcher-registration wait. Never end a turn waiting for registration: continue independent work, or end the turn and resume at the next natural wakeup. Any session
may adopt an unspawned prepared definition. If the tool returns `RESTART_NOTICE`, restart plugin
loading or use `/reload-plugins` as directed. A route with no stable executor, such as haiku, must use
`--ephemeral`; instant dispatch will explain that fallback.

Re-dispatch rotates the token while the stable executor name remains fixed. A stale token is refused,
and `done` or `release` clears the dispatch guard for either mode. An Agent acknowledgement means only
`launched`. Pulse the ticket immediately and report it as running only after the holder and dispatch
token are visible. A missing claim means diagnose or respawn, never wait for a completion notification.
Never trust a worker's self-reported identity. The token-gated claim and the dispatch response are the evidence.

## Routed Agent dispatch

All routed execution stays in the current conversation. Call `dispatch <ref>` through the CLI or MCP,
then pass its exact stable executor, `spawn` object, and complete `briefing` unchanged to Agent. The
executor claims using the returned token, its exact executor name, and the stamped effort. The claim guard
is the proof that the right route ran. For Codex, preserve the briefing's one route marker unchanged so the
gateway receives the resolved model and effort; never add, rewrite, or combine markers. Dispatch is the
current board interface for routed work.
