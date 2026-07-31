# skill-retro

Mines your recent Claude Code transcripts for work that keeps getting redone, then routes each finding
to the cheapest durable fix.

The point is the routing. Detecting that you ran the same command eleven times is easy; deciding whether
that wants a skill, a bundled script, a live rule, a memory entry, a codebase-map edit, or nothing at
all is the part worth doing, and it is the part a padded report gets wrong.

## Why a script does the reading

A busy session is around 37 MB and 11,700 JSONL records. Reading one into context would exhaust the
window and still cover less than a scan of forty. The bundled CLI streams transcripts line by line and
emits bounded aggregates; nothing but the summary reaches the model.

## It mines the whole loop, not just you

Three actors leave traces, and only one of them is you:

- **You**, in corrections and preferences.
- **The main loop**, redoing the same orientation work session after session.
- **Subagents**, under `~/.claude/projects/<slug>/<session>/subagents/`, each with a `.meta.json`
  naming its agent type and model. In an orchestrated repo this is usually most of the work, and it is
  invisible in the main transcript: subagent turns are written only to those side files.

Who repeated the work changes where the fix belongs. A skill only helps someone who thinks to invoke
one, so work that executors keep redoing routes to a script they can call, a rule scoped to the files
they edit, or a map entry loaded before they start reading.

## What it detects

| Signal | Default route |
|---|---|
| Private data in an untracked, unignored path | gitignore entry, then a memory entry for why |
| A command shape repeated 3+ times | a bundled script, the parts that varied as CLI arguments |
| A failure and the retry that fixed it | fix into the script, reason into the skill body |
| A script rewritten from scratch more than once | salvage the working copy, never regenerate it |
| An artifact rebuilt in a temp directory every session | give it a home and a CLI |
| Orienting reads before the first change | a codebase-map entry |
| A repeated correction from you | a live rule, never a skill |
| Repeated permission denials | a settings allowlist |

Hazards are reported first regardless of how often they happened, because the cost of a credential
reaching a commit is not proportional to frequency. Everything else has to earn its place: one-offs are
dropped and counted rather than padded into the report.

Every route above can land on something the repo already has. The report carries an **Amend first** line
saying so, because a skill that was invoked while the work got redone anyway needs its body fixed, and a
skill that covers the work but never got invoked needs its description widened. Both leave the same trace
in a transcript, and shipping a second skill instead of fixing the first one leaves two half-right
skills where there was one.

## Usage

```bash
node bin/skill-retro.js mine --project /path/to/repo
```

Defaults to the current project, the last 7 days, and at most 5 sessions, whichever is tighter. The
window it actually used, including what the cap skipped, is printed at the top of every report.

| Flag | Effect |
|---|---|
| `--days N` / `--sessions N` | Widen or narrow the window |
| `--all-projects` | Scan every project, for habits that span repos. Much slower |
| `--no-subagents` | Skip subagent transcripts, usually the larger half |
| `--out DIR` | Where `report.md`, `findings.json`, and `salvage/` land |
| `--format json` | Machine-readable output for headless use |

Then verify what it salvaged:

```bash
node bin/skill-retro.js verify --dir <report-dir> [--run]
node bin/skill-retro.js salvage --dir <report-dir> --id salvage-1 --to scripts/probe.mjs
```

`verify` syntax-checks every salvaged file. With `--run` it replays the command that proved the script
worked and diffs against the output the transcript recorded at the time, so "does this still work" is
answered rather than assumed. Execution is opt-in because the command is replayed from a transcript.

A script that only passed the syntax check is reported as **unproven**, never as working.

## Redaction

Every reported string is redacted before it is written or shown: dispatch tokens, bearer headers, API
keys, private key blocks, and high-entropy strings. Real transcripts contain live credentials, and a
report that quotes one has copied it into a file and into a model's context. Salvaged script bodies are
written to disk unredacted, because they are your own files and redacting them would break them.

## Optional session nudge

Off by default. Set `SKILL_RETRO_NUDGE=on` in a project's `.claude/settings.local.json` env block and a
SessionEnd hook starts counting finished sessions; once `SKILL_RETRO_NUDGE_EVERY` (default 10) have gone
by, the next SessionStart mentions it. The tally is kept at SessionEnd but delivered at SessionStart,
because a session that is ending has no context left to inject into. Counting only, never mining, so
ending a session stays instant.

## Relationship to `workbench:retro`

`workbench:retro` reflects on the session in context right now: subjective, immediate, no disk access.
This mines what nobody remembers, across sessions and executors, from transcripts on disk. They hand off
to the same tools and do not overlap.

## Tests

```bash
node --test "test/*.test.js"
```
