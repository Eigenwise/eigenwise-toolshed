---
title: Playbook setup
description: Practice skills for working with Claude Code, plus retros that find the next one worth writing down.
---

Playbook holds two kinds of thing: written practice for how to work, and the retros that find what
should become written practice.

```text
/plugin install playbook@eigenwise-toolshed
```

| Skill | What it covers |
| --- | --- |
| `/playbook:fan-out` | Splitting work across parallel subagents in git worktrees, and consolidating it back |
| `/playbook:pick-model` | What each reachable model is good at, so a model gets suggested with a reason |
| `/playbook:verify-discipline` | Running tests without burning the clock or the context window |
| `/playbook:retro` | Reflecting on the session in context right now and applying the fixes |
| `/playbook:skill-retro` | Mining transcripts on disk for work that keeps getting redone |

`fan-out`, `pick-model`, and `verify-discipline` are guidance with no code behind them. `retro` and
`skill-retro` are how a new play gets found.

## Running work across parallel agents

`/playbook:fan-out` covers splitting a task across subagents in isolated git worktrees and
consolidating the results. You decide when to fan out; the skill covers how to split the work
without breaking it.

The split is where fan-out usually fails. Two agents that each fix one side of a single algorithm
produce two locally correct changes that contradict each other, so work that shares one algorithm
stays under one owner. Editing the same file is not a conflict, because worktrees isolate the
filesystem; a shared port, database, or dev server is a conflict, because they do not.

Worktrees fork from `origin/main` rather than local `HEAD`. Dependent work therefore needs its
prerequisite pushed before the dependent agent starts, and reviewing an agent's work means diffing
against the merge base (`git diff $(git merge-base origin/main <commit>) <commit>`) rather than
against `main`, which would otherwise attribute unrelated commits to that agent.

Fan-out costs more than working directly and does not improve quality on work that fits in one
context window. Measured across two internal benchmark suites, parallel orchestration ran roughly
1.2 to 1.4 times the cost and five to six times the requests for identical scores. Use it for
breadth that will not fit in one context.

## Choosing a model

`/playbook:pick-model` describes what each reachable model is good at, what it is a bad choice
for, and which ids are deprecated or retiring, so a model can be suggested with a stated reason
rather than picked by habit. It covers Anthropic models everywhere, and the Codex and Grok models
when [Model Gateway](./model-gateway/) makes them reachable. Each claim is marked as vendor or
independent sourcing, and where a question has no measured answer, the skill says so instead of
guessing.

Three findings from it are worth knowing before reading anything else. Reasoning effort is not
monotonic: Opus 5 peaks near medium effort on some coding tasks and gets both worse and more
expensive above it, and Sonnet 5 above high effort can cost more per task than Opus 5 despite its
lower rate. Advertised Codex context is not what a session gets, since Claude Code hardwires a
200,000-token window for any `claude-`prefixed id. And the most expensive model is rarely the right
default, because Fable 5 costs twice Opus 5 for a statistical tie on general intelligence.

The skill records model facts that change within weeks. Its stated research date is what makes it
trustworthy; treat vendor documentation as authoritative wherever the two disagree.

## Verifying without burning the clock

`/playbook:verify-discipline` covers which test command to run and when. Measured over four days on
one machine, shell verification took 284.5 of 341 minutes of tool time. The full suite averaged 51.3
seconds across 217 runs while file-scoped tests averaged 21.5 seconds across 197, and 48 transcripts
ran a suite at least five times, accounting for 520 of 706 runs. The cost is in repeating a broad
gate after every edit.

The rule is a narrow reliable check while iterating and the full suite once at the end. A passing
suite's output also carries no information beyond its exit code and summary counts, so the skill
redirects the full run to a log and prints only the status and the failures, preserving the exit
code so the gate still holds.

This matters most for agents you dispatch, since 566 of those 693 runs came from subagents and their
output lands in a context you pay for and never see. Brief an agent with both commands already
filled in.

## Mining transcripts

Ask for a retro in plain language: "what do I keep redoing", "what do you keep redoing", "run a
transcript retro". The `skill-retro` skill runs the bundled miner, reads the summary it produces, and
comes back with a ranked report.

### What it reads

Transcripts live at `~/.claude/projects/<project-slug>/<session-uuid>.jsonl`, one JSON record per line.
Subagent transcripts sit alongside them at
`~/.claude/projects/<project-slug>/<session-uuid>/subagents/agent-*.jsonl`, each with a `.meta.json`
naming the agent type and model that produced it.

A busy session runs to tens of megabytes, so nothing reads one directly. The plugin ships a CLI that
streams transcripts line by line and emits bounded aggregates, and the skill is instructed to always go
through it:

```text
node "${CLAUDE_PLUGIN_ROOT}/bin/playbook.js" mine --project "${CLAUDE_PROJECT_DIR}"
```

By default it scans the current project over the last 7 days, up to 5 sessions, whichever limit is
tighter. Every report opens with the window it actually used, including how many sessions the cap
skipped. Use `--days` and `--sessions` to widen it, `--all-projects` for habits that span repos, and
`--no-subagents` to skip the larger half.

### It covers the whole loop

Findings are attributed to whoever produced them: you, the main session, or a named subagent. That
attribution changes the fix. A skill only helps someone who thinks to invoke one, so work that
agents keep repeating routes instead to a script they can be told to call, a live rule scoped to the
files they edit, or a codebase-map entry that loads before they start reading.

### Applying findings

The report ranks findings by how often they happened and how much measured tool time they took. Repeated
commands show their total and average elapsed time plus their share of measured tool time, so a slow verify
loop ranks above a cheap command that happened more often. Hazards still come first regardless
of either metric. It proposes a route for each: a skill, a bundled script, a live rule, a memory entry, a
codebase-map edit, a settings allowlist, or a ticket. Nothing is written until you approve it, and each
approved fix is applied as its own step through the tool that owns it, so any one of them is easy to undo.

Genuine one-offs are dropped and counted rather than padded into the report.

### A route can point at something you already have

Most routes carry an **Amend first** line, because the artifact that should have handled the work often
already exists and fell short. Editing it beats adding a rival next to it: two skills covering one job
means every reader has to work out which one is authoritative, while the broken one keeps its name.

The transcript says which edit it needs. A skill that was invoked while the work still got redone has a
body problem, usually a step vague enough to skip. A skill that covers the work but never got invoked
has a description problem, and the words in the transcript are the words that failed to match it. A
script that exists while the command still varied by hand is missing an argument. A rule that exists
while the edits went unguided has a glob that missed the files. Those are different fixes, so the
proposal names which one it is before anything gets written.

### Salvaged scripts are tested, not assumed

When a script was rewritten from scratch more than once, the plugin recovers the last working version
out of the transcript instead of writing a new one. Verify it before using it:

```text
node "${CLAUDE_PLUGIN_ROOT}/bin/playbook.js" verify --dir <report-dir> --run
```

That syntax-checks the file, then replays the command that proved it worked and diffs the result against
the output the transcript recorded at the time. Execution is opt-in because the command is replayed
from a transcript, so read it first. A script that only passed the syntax check is reported as
**unproven**, never as working.

### Redaction

Real transcripts contain live credentials. Every string in the report and the findings file is redacted
before it is written: bearer headers, API keys, private key blocks, and high-entropy strings. Salvaged
script bodies are written to disk unredacted, since they are your own files.

### Optional session nudge

Off by default. To be reminded that a retro is due, add this to a project's
`.claude/settings.local.json`:

```json
{
  "env": {
    "PLAYBOOK_NUDGE": "on",
    "PLAYBOOK_NUDGE_EVERY": "10"
  }
}
```

A SessionEnd hook then counts finished sessions, and once the threshold is passed the next session start
mentions it. The tally is kept at SessionEnd but delivered at SessionStart, because a session that is
ending has no context left to inject into. It only counts, never mines, so ending a session stays
instant.

## The two retros

`/playbook:retro` reflects on the session in context right now: subjective, immediate, no disk access.
`/playbook:skill-retro` mines what nobody remembers, across sessions and subagents, from transcripts on
disk. Reach for `retro` when the friction is something only this session can see, and `skill-retro`
when the question is what you keep redoing.
