---
name: fan-out
description: >-
  Run several subagents in parallel git worktrees and consolidate their work. Use when asked to fan
  out, parallelize, split work across agents, use subagent teams, or run agents in worktrees.
---

# Fan out

Split work across parallel subagents in isolated git worktrees, then consolidate. The user decides
when this happens. You do not fan out on your own initiative because a task "looks big".

## Fan out only when it actually pays

Parallel agents cost more than doing the work yourself, and on work that fits one context they buy
no measurable quality. Measured on two benchmark suites here: parallel orchestration ran ~1.2-1.4x
the cost and 5-6x the requests for identical scores. So the reason to fan out is **breadth you
can't hold**, not quality:

- The work is bigger than one context window and splits into pieces that don't need to see each
  other.
- Several pieces are genuinely independent: different subsystems, different services, a sweep across
  many files where each file is its own decision.
- You want independent perspectives on the same question (review, design options), and the value is
  in the disagreement.

Don't fan out for a task you could finish in one pass. Don't fan out to "go faster" on something
serialized by its own dependencies.

## The split is the whole game

Most fan-out failures are splitting failures, not agent failures.

**Never split one algorithm across two agents.** The classic break: a decoder and its encoder, a
parser and its printer, a scheduler's two timing paths. Two agents each fix their side, each fix is
locally correct, and together they contradict. One owner takes both sides and re-proves both
directions, or it isn't split.

The test: *could agent A's change make agent B's tests wrong without touching B's files?* If yes,
same owner.

**Split by surface, not by file count.** Store layer, CLI, HTTP surface, docs, tests. A surface has
a boundary you can state in one sentence and verify on its own.

**Same file is not a conflict.** Worktrees isolate the filesystem, so two agents editing the same
file in different regions merge fine. Serialize only on:

- **Region overlap** — both rewriting the same function.
- **Runtime resources** — a port, a dev server, a database, a shared fixture directory. Worktrees do
  not isolate these. Two agents binding :5173 collide no matter how separate their files are.
- **Semantic dependency** — B's work only makes sense against A's finished interface.

Everything else runs at once. Whatever can run in parallel should.

## Worktree mechanics

Each agent gets `isolation: "worktree"` on the Agent call. Drop that field and every agent lands in
the shared checkout, which is how you get half-written files fighting each other on the branch
you're sitting on.

Worktrees fork from `origin/main`, not from your local HEAD. Two consequences:

- **Push before dispatching dependent work.** If B needs A's interface, A's commit has to be on
  `origin/main` before B's worktree is created, or B forks from a tree that never had it.
- **Diff against the merge base, never against main.** An agent's worktree has drifted from your
  main since it forked, so a plain `git diff main..<commit>` shows other people's work as if it were
  theirs:

  ```
  git diff $(git merge-base origin/main <commit>) <commit>
  ```

  This is the only diff that shows what that agent actually did.

Never reuse a dead or released agent's worktree, and never resume an agent after its worktree is
cleaned up. Its writes land in the shared checkout. Salvage the diff first if there's work worth
keeping, then start a fresh agent.

## Brief each agent like it can't ask questions

Because it can't, cheaply. A subagent starts with none of your context and every gap becomes an
invented assumption.

Each brief carries:

- **The contract in full.** Exact interfaces, types, and file boundaries it owns. Do not narrow it
  to "the relevant part" — you will guess wrong about what's relevant.
- **The evidence you already gathered.** File paths with line numbers, the failing output, the
  reason the obvious approach doesn't work. Front-loading this is cheaper than the agent
  rediscovering it.
- **What's already been proven and must stay true.** If an earlier pass established that the decoder
  handles fractional input, say so. Otherwise the next agent "fixes" it back.
- **The exact verify commands**, copy-pasteable, with the directory to run them from: the scoped one
  for iterating and the full one for the end. See `verify-discipline`. An agent that has to invent
  its test command invents a slow one.
- **Bounds**: what it must not touch, and permission to come back rather than grind. An agent that
  bounces after two failed attempts costs less than one that improvises for an hour.

## While they run, leave them alone

Between dispatch and result, do nothing with that piece of work. No polling, no peeking into
worktrees, no reading half-finished files. It costs a full-context turn every time and it changes
nothing.

Judge the result by its oracle: run the verify command, read the report. Not by re-reading the
diff line by line. If the work genuinely needs human-grade review, that's its own separate pass with
its own agent, not you re-doing the work you delegated.

## Consolidate as one integrator

You merge. Agents stop at a verified commit in their own worktree and hand you the hash.

1. Read each report, run each agent's own verify command.
2. Merge them one at a time, resolving conflicts yourself.
3. Run the **full** suite once, after everything is in. Per-agent scoped verifies during the work,
   full suite as the ship gate. Each piece passing alone does not mean the seams hold.
4. Only then push.

The seam is where fan-out breaks. Two agents both passing their own tests is the normal state right
before an integration failure.

## Picking models

Different pieces deserve different models. Don't route everything to the most expensive one you
have. See the `pick-model` skill for what each model is actually good at, and suggest a split to the
user rather than deciding silently.

## Guidelines

- **The user calls the fan-out.** Suggest it, size it, then wait.
- **Say the split out loud before spawning.** "Four agents: store, CLI, docs, tests." If the split is
  wrong, that sentence is where it's cheapest to fix.
- **Spawn a wave in one message** so they run concurrently, not one at a time.
- **Report what you dropped.** If you capped the fan-out or skipped a piece, say which. Silence reads
  as full coverage.
