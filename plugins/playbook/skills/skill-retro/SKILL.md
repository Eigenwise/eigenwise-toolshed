---
name: skill-retro
description: >-
  Mine recent Claude Code transcripts, including subagent transcripts, for work that keeps getting
  redone, then turn each finding into a new or amended skill, bundled script, live rule, memory entry,
  codebase-map edit, or ticket. Use for a cross-session retro, "what do I keep redoing", "what do you
  keep redoing", turning repeated work into tooling, fixing a skill that keeps failing to trigger or to
  be followed, or auditing recent sessions for waste and for private data that was one commit from being
  exposed.
---

# Skill retro

Find the work that keeps getting repeated across recent sessions and convert it into something durable.
The repetition is spread across sessions, so nobody remembers it: you do not recall last Tuesday's
session, and an executor that ran an hour ago has no memory at all. The transcripts do remember, and
this reads them.

## Never read a transcript yourself

A single busy session is 37 MB and roughly 11,700 JSONL records. Reading one would exhaust the context
window and still tell you less than a scan of forty. **Always go through the bundled CLI**, which
streams line by line and emits bounded aggregates.

```text
node "${CLAUDE_PLUGIN_ROOT}/bin/playbook.js" mine --project "${CLAUDE_PROJECT_DIR}"
```

Defaults to the current project, the last 7 days, and at most 5 sessions, whichever is tighter. Useful
flags: `--days`, `--sessions`, `--all-projects` for habits that span repos, `--no-subagents` to skip the
larger half, `--out <dir>` to control where `report.md`, `findings.json`, and `salvage/` land.

**Always state the window you actually got.** It is printed at the top of the report, including how many
sessions inside the day range were skipped by the session cap. A finding means nothing without knowing
what was looked at.

## Mine the whole loop, not just the user

Three actors leave traces, and each one routes differently:

- **The user.** Corrections and preferences.
- **The main loop.** Work you redo yourself across sessions.
- **Subagents.** Executors under `<session>/subagents/`, each with a `.meta.json` naming its agent type
  and model. This is usually most of the work in an orchestrated repo, and it is invisible in the main
  transcript because subagent turns are written only to those side files.

The report attributes every finding to its actors. **Who repeated the work changes where the fix
belongs.** Ten executors running the same verify command is a stronger signal than you running it three
times, and it rules out a skill: an executor never thinks to invoke one. It needs a script it can call,
a rule scoped to the files it edits, or a map entry loaded before it starts.

## Route every finding, and drop the rest

Routing is the judgment this pass exists to make. The CLI proposes a route; overrule it when you know
better, because it cannot see what already exists in the repo. Read
`references/routing-rubric.md` for the full table and the reasoning behind each choice.

The short version:

| Finding | Goes to |
|---|---|
| Private data in an untracked, unignored path | gitignore entry now, then a memory entry for why |
| A command shape with parts that varied | a bundled script, varied parts as CLI arguments |
| A failure and the retry that fixed it | fix into the script, reason into the skill body |
| A script rewritten from scratch more than once | salvage the working copy, never regenerate it |
| Orienting reads before every first change | a codebase-map entry |
| A repeated user correction | a live rule, never a skill |
| A one-off correction with a reason worth keeping | a memory entry |
| Repeated permission denials | a settings allowlist |
| A skill that was invoked and the work got redone anyway | an edit to that skill's body |
| A skill that covers the work but never got invoked | an edit to that skill's description |
| Real work with no obvious owner | a ticket |

**Drop genuine one-offs.** A report padded with things that happened once trains the reader to skim the
next one, which costs more than the padding ever saves. An honest "three findings" beats a manufactured
twelve. If nothing recurred, say so and stop.

## Amend what exists before you add anything

Every route names a destination, and the destination often already exists. A near-miss skill sitting
beside a second near-miss skill is worse than either alone: both look authoritative, and neither works.
So before proposing anything new, go looking for the artifact that already owns this territory, in the
plugins directory, `.claude/live-rules/`, `.claude/.codebase-info/`, the memory directory, and the skills
this session already has listed. The report prints an **Amend first** line on every route that can write
an artifact, because the miner reads transcripts and cannot see the repo.

When one does exist, the transcript says which edit it needs, and they are opposite edits:

- **It ran and the work got redone anyway.** The body is the problem: a step missing, a default that is
  wrong for this repo, an instruction vague enough to skip. Sharpen that instruction and say why, so it
  survives the next person who finds it inconvenient.
- **It never ran and it should have.** The `description` is the problem. The words in the transcript are
  the words that failed to match, so add those. Widen it without narrowing it; the triggers it already
  catches are ones nobody is complaining about.
- **A script exists but the command still varied by hand.** What varied is a missing argument or flag.
- **A rule exists but the edits went unguided.** Its glob missed the files that were actually touched.

Name which one the evidence supports. "Amend the skill" with no diagnosis produces an appended bullet,
and appended bullets are how a skill reaches three screens and starts getting skimmed.

A skill that nobody invoked looks identical in a transcript to a skill that does not exist, so check
before concluding either. Only genuinely different territory earns a new artifact. Amending something
other projects use is a shared change, so it goes through the same propose-then-apply steps below.

## Verify before you write anything

A retro that ships a broken script has negative value: it costs debugging time and it burns trust in
every later report. Before proposing any fix, and again before applying it:

- **Cited paths exist.** Check each one. A finding that names a moved file is already wrong.
- **Scripts parse.** `playbook verify --dir <report-dir>` runs a syntax check on every salvaged file.
- **Salvaged scripts are tested against the data they were mined from.** When the transcript recorded a
  successful run, it holds both the script and the output it produced. `verify --run` replays that
  command against the salvaged copy and diffs the result, so "does this still work" is answered rather
  than assumed. Execution is opt-in because the command is replayed from a transcript; read it first.

Never present a salvaged script as working when only its syntax was checked. Say which check it passed.

## Propose, then apply as separate steps

1. **Show the ranked report first.** Hazards at the top regardless of how often they happened, because
   the cost of private data reaching a commit is not proportional to frequency. Then each finding with
   its evidence, its actors, and its proposed route.
2. **Let the user approve, drop, or re-route.** These are workspace changes, and some of them are shared.
3. **Apply each approved fix as its own step**, through the tool that owns it: `add-rule` for a live
   rule, `update-codebase-map` for the map, `skill-creator` for a skill, whether that means writing one
   or editing one that fell short, a direct edit for a gitignore entry, a memory file for a memory entry.
   One step each, so any one is easy to undo.
4. **Re-verify after writing.** A new rule's globs should match real files; a new skill needs a
   description that will actually trigger; a bundled script needs real CLI arguments.

## Skills this writes or amends follow house style

When a finding routes to a skill, write it, or edit it, the way the rest of the Toolshed writes them,
because a skill that does not trigger is dead weight and a skill nobody can follow gets ignored:

- The `description` says **what it does and when to use it**, in the words someone would actually type.
  Triggering is the whole job of that field.
- The body is **imperative**, and each instruction says **why it matters**. An instruction without a
  reason gets dropped the first time it is inconvenient.
- Bundled scripts take **real CLI arguments**. A hardcoded absolute path makes the script work on
  exactly one machine, which is the same as not shipping it.

See `references/skill-house-style.md` before writing one.

## How this differs from `playbook:retro`

`playbook:retro` reflects on the session in your context right now: subjective, immediate, no disk
access. This mines what nobody remembers, across sessions and across executors, from transcripts on
disk. They hand off to the same tools and do not overlap. If the friction is something only this
session's context can see, that is `playbook:retro`; if the question is "what do we keep redoing," it is
this.

## Success criteria

- [ ] Mined through the CLI, never by reading a transcript into context
- [ ] The actual window reported, including sessions skipped by the cap
- [ ] Findings attributed to user, main loop, or named subagents, and routed accordingly
- [ ] Existing coverage searched for before any new artifact was proposed, and every amendment names its
      diagnosis and the edit it needs
- [ ] Hazards reported first regardless of frequency
- [ ] One-offs dropped rather than padded into the report
- [ ] Cited paths checked, salvaged scripts parsed, and tested against recorded output where it exists
- [ ] Proposals shown before anything was written
- [ ] Each approved fix applied as its own step through the tool that owns it
