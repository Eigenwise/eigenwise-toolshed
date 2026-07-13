# Orchestration: fan-out, workflows, and agent teams

Read this when you're about to run more than a couple of executors at once, when agent teams is on,
or when a workflow might fit. The baseline
delegation rule (route execution down to each ticket's stamped cheap tier as short bounded runs,
batch small same-tier tickets, fan out over independent waves, inline only trivial one-steps) lives
in the main skill — this file is the detail on the bigger shapes.

## Fan-out mechanics

When several tickets are **ready and independent**, work them in parallel — one executor per ticket,
all spawned in a **single message** (true parallel). This is safe precisely because claiming is
atomic: each subagent claims a different ticket, and any race just sends the loser onward.

- **Name every worker.** Each concurrent subagent gets a unique `name` (lowercase-hyphens, e.g.
  `exec-sq12`). Naming makes it addressable: it shows in the fleet view (filter `a:<name>`) and is
  resumable via `SendMessage {to: name}` with its history intact. Never spawn an anonymous worker.
  Built-in Explore/Plan agents are one-shot and NOT resumable — when a scout's work must be picked
  back up, use a general-purpose or custom named agent (e.g. `code-explorer`) instead.
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
- **Executor prompts stay lean**: the ref, the claim/done commands with the worker id, the stamped
  effort/model, and anything the ticket description doesn't already carry. The ticket IS the spec —
  don't paste the codebase into the prompt. Ask executors to report tersely (what changed, files/lines,
  verification output, close confirmation) — data, not prose.
- Parallelism costs tokens and orchestration overhead — a couple of parallel investigations or an
  executor wave where sizes justify it, not a swarm for everything.

## Scouting

Scout before decomposing only when the surface is genuinely unfamiliar AND large: one or two
read-only explorers, each on a distinct subsystem or open question, spawned together. A scout returns
**compressed findings** — a pointer list or short summary (~1–2k tokens), never its reading
transcript. The output feeds your ticket boundaries — guessing boundaries on a big unknown codebase
produces tickets that collide.
For a codebase you already know, or a task whose files you can name, skip the scout and just read the
files. A substantive investigation (root-cause hunt, spike) is different from a scout: it gets a
ticket, and its findings get commented back (see the main skill).

## Workflows (opt-in — you propose, the user approves)

The default parallelizer is named-subagent fan-out — always available, turn-by-turn, supervised. A
**Claude Code Workflow** built with `agent()` and `pipeline()` is the heavier tool for a larger,
repeatable, or deterministic run: results stay in script variables, only the final output returns.

- **Sizing** (by the story's complexity): small <5 · medium <15 · large <50, within the runtime cap
  of 16 concurrent / 1000 total per run.
- **Gated**: you don't launch one on your own — the user opts in (an "ultracode" prompt, or an
  explicit ask). But you usually judge better than the user when one would genuinely help, so **when
  it would, SUGGEST it** via `AskUserQuestion`: why it fits, the rough scale, the token cost, and a
  script shape such as `pipeline(tickets, ticket => agent(ticket.prompt, { label: ticket.ref }))`.
  Raising the option is how the opt-in happens; staying silent when a workflow would clearly help is
  the mistake.
- Typical fits: a wave of 6+ same-shaped executor tickets, a repeatable migrate/verify sweep, a
  find→verify review structure.

## Agent teams (CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS)

With agent teams on (a **per-user** flag), parallel workers spawn as manageable teammates. The routing
rules do not change, and one thing is critical: a teammate is a real sidequest executor **only if it
has BOTH the correct agent type AND a unique `name`** — spawn the ticket's `sidequest-exec-<effort>`
type with `model: <tier>`, `mode: "bypassPermissions"`, plus the name, exactly as you would a
subagent. Sidequest executors are unattended; omitting bypass sends every Bash approval into the lead
session. The failure to avoid:
letting the "spawn a team" reflex launch default/generic teammates — a generic or unnamed teammate
throws away the executor protocol (won't claim, won't verify, won't `done`), the tier routing, and
addressability.

Caveats:

- A teammate may **inherit the lead's reasoning effort** instead of the effort the agent name implies.
  Spawn the correctly-named executor regardless — the claim's `--effort` check still enforces the
  right tier took the ticket. If it matters, also state the effort in the spawn prompt.
- **Model does not inherit** — always pass `model: <tier>` explicitly.
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

## Native Agent dispatch

All routed execution stays in the current conversation. Call `native_agent`, pass its returned spawn
object unchanged to Agent, and call `native_agent_cleanup` when the executor finishes. `sidequest work`
and MCP `dispatch` are disabled because they cannot invoke Agent and must never start a separate Claude
process.
