---
title: Skill Retro setup
description: Mine recent Claude Code transcripts for repeated work and turn it into skills, scripts, and rules.
---

Skill Retro reads your recent Claude Code transcripts and finds the work that keeps getting redone, then
proposes where each fix belongs.

```text
/plugin install skill-retro@eigenwise-toolshed
```

Ask for a retro in plain language: "what do I keep redoing", "what do you keep redoing", "run a
transcript retro". The `skill-retro` skill runs the bundled miner, reads the summary it produces, and
comes back with a ranked report.

## What it reads

Transcripts live at `~/.claude/projects/<project-slug>/<session-uuid>.jsonl`, one JSON record per line.
Subagent transcripts sit alongside them at
`~/.claude/projects/<project-slug>/<session-uuid>/subagents/agent-*.jsonl`, each with a `.meta.json`
naming the agent type and model that produced it.

A busy session runs to tens of megabytes, so nothing reads one directly. The plugin ships a CLI that
streams transcripts line by line and emits bounded aggregates, and the skill is instructed to always go
through it:

```text
node "${CLAUDE_PLUGIN_ROOT}/bin/skill-retro.js" mine --project "${CLAUDE_PROJECT_DIR}"
```

By default it scans the current project over the last 7 days, up to 5 sessions, whichever limit is
tighter. Every report opens with the window it actually used, including how many sessions the cap
skipped. Use `--days` and `--sessions` to widen it, `--all-projects` for habits that span repos, and
`--no-subagents` to skip the larger half.

## It covers the whole loop

Findings are attributed to whoever produced them: you, the main session, or a named subagent. That
attribution changes the fix. A skill only helps someone who thinks to invoke one, so work that
executors keep repeating routes instead to a script they can be told to call, a live rule scoped to the
files they edit, or a codebase-map entry that loads before they start reading.

## Applying findings

The report ranks findings by how often they happened and how much measured tool time they took. Repeated
commands show their total and average elapsed time plus their share of measured tool time, so a slow verify
loop ranks above a cheap command that happened more often. Hazards still come first regardless
of either metric. It proposes a route for each: a skill, a bundled script, a live rule, a memory entry, a
codebase-map edit, a settings allowlist, or a ticket. Nothing is written until you approve it, and each
approved fix is applied as its own step through the tool that owns it, so any one of them is easy to undo.

Genuine one-offs are dropped and counted rather than padded into the report.

## A route can point at something you already have

Most routes carry an **Amend first** line, because the artifact that should have handled the work often
already exists and fell short. Editing it beats adding a rival next to it: two skills covering one job
means every reader has to work out which one is authoritative, while the broken one keeps its name.

The transcript says which edit it needs. A skill that was invoked while the work still got redone has a
body problem, usually a step vague enough to skip. A skill that covers the work but never got invoked
has a description problem, and the words in the transcript are the words that failed to match it. A
script that exists while the command still varied by hand is missing an argument. A rule that exists
while the edits went unguided has a glob that missed the files. Those are different fixes, so the
proposal names which one it is before anything gets written.

## Salvaged scripts are tested, not assumed

When a script was rewritten from scratch more than once, the plugin recovers the last working version
out of the transcript instead of writing a new one. Verify it before using it:

```text
node "${CLAUDE_PLUGIN_ROOT}/bin/skill-retro.js" verify --dir <report-dir> --run
```

That syntax-checks the file, then replays the command that proved it worked and diffs the result against
the output the transcript recorded at the time. Execution is opt-in because the command is replayed
from a transcript, so read it first. A script that only passed the syntax check is reported as
**unproven**, never as working.

## Redaction

Real transcripts contain live credentials. Every string in the report and the findings file is redacted
before it is written: dispatch tokens, bearer headers, API keys, private key blocks, and high-entropy
strings. Salvaged script bodies are written to disk unredacted, since they are your own files.

## Optional session nudge

Off by default. To be reminded that a retro is due, add this to a project's
`.claude/settings.local.json`:

```json
{
  "env": {
    "SKILL_RETRO_NUDGE": "on",
    "SKILL_RETRO_NUDGE_EVERY": "10"
  }
}
```

A SessionEnd hook then counts finished sessions, and once the threshold is passed the next session start
mentions it. The tally is kept at SessionEnd but delivered at SessionStart, because a session that is
ending has no context left to inject into. It only counts, never mines, so ending a session stays
instant.

## Alongside Workbench retro

`workbench:retro` reflects on the session in context right now: subjective, immediate, no disk access.
Skill Retro mines what nobody remembers, across sessions and executors, from transcripts on disk. Reach
for `workbench:retro` when the friction is something only this session can see, and Skill Retro when the
question is what you keep redoing.
