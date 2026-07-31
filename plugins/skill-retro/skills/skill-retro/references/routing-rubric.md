# Routing rubric

Every finding gets exactly one destination, and that destination is as often an artifact that already
exists as a new one. Choosing it is the judgment the pass exists to make: the detectors can only say
what recurred, not what should be done about it.

## The destinations

| Route | What it is | Reaches |
|-------|------------|---------|
| **gitignore + memory** | An ignore entry, plus a memory file recording why the path exists | Immediately, permanently |
| **bundled script** | An executable under a plugin's `bin/` or the project's `scripts/`, with CLI arguments | Anyone who is told about it, including executors |
| **skill** | A `SKILL.md`, usually wrapping a script, for when *choosing* to run it needs judgment | Whoever invokes it, or whoever the description triggers |
| **live rule** | A scoped rule in `.claude/live-rules/rules/` | Injected automatically, on every matching prompt or edit |
| **memory entry** | A file under the project's memory directory | Loaded at session start |
| **codebase map** | A document under `.claude/.codebase-info/` | Injected at session start, including for executors |
| **settings (permissions)** | An allowlist entry in `.claude/settings.json` | The harness, silently |
| **ticket** | A Sidequest ticket | A future executor |
| **drop** | Nothing | Nobody, deliberately |

`settings` sits outside the usual six on purpose. Repeated permission denials are a configuration gap,
not a behavior anyone needs corrected, and routing them anywhere else produces a fix that cannot work.

## Amend or create

A route names a destination. It does not say the destination has to be new, and most of the time it
should not be: the repo has been accumulating skills, scripts, and rules for as long as the friction has
been recurring, so the odds that something already claims this territory are good. Look before writing.
Two artifacts covering one job is worse than one broken artifact, because now every reader has to work
out which is authoritative, and the broken one keeps its name.

Diagnose from the transcript, because each symptom needs a different edit:

| What the transcript shows | What is broken | The edit |
|---|---|---|
| The skill was invoked, the work still got redone | The body | Sharpen the instruction that got skipped, with its reason |
| The skill was never invoked, and should have been | The `description` | Add the words that were actually typed |
| A script exists, the command still varied by hand | The signature | Turn what varied into an argument |
| A rule exists, the edits went unguided | The glob | Widen it to the files that were actually touched |
| A map entry exists, the area got re-derived anyway | The entry | Extend it with what was re-derived |
| Nothing covers this territory | Nothing | A new artifact |

The last two rows are the ones people confuse. A skill nobody invoked leaves exactly the same trace as a
skill that does not exist: work done by hand, no skill in the transcript. The fixes are opposite, so
check what is on disk before deciding which case you are in. Guessing produces a duplicate of a skill
that only ever needed six more words in its description.

Amending is a smaller change than creating, and it is also a riskier one when the artifact is shared:
other projects load the same skill or rule, and they are not in the window you mined. Say so in the
proposal, and treat it like any other shared change.

## Choosing between a script and a skill

A **script** is right when the work is mechanical: the same steps, differing only in arguments. If you
can name what varied, those are the CLI arguments, and there is no decision left to write down.

A **skill** is right when the hard part is *knowing when and whether* to run something. A skill wrapping
a script with no judgment in it adds a layer that has to be maintained and invoked, for nothing.

The tie-breaker is the audience. A skill only helps someone who thinks to invoke it. When the repetition
comes from **subagents**, a skill is close to useless, because an executor works from its briefing and
does not go shopping for skills. Route subagent repetition to a script they can be told to call, a rule
scoped to the globs they edit, or a map entry loaded before they start reading.

## Choosing between a rule and a memory entry

A **live rule** is for behavior that must arrive unbidden, because the failure mode is forgetting. A
repeated correction is the clearest case: the reason it repeated is that nobody remembered it, so a
destination that has to be looked up will fail the same way.

A **memory entry** is for a fact, a decision, or a preference with a reason. It carries the *why*, which
is the part that stops the correction recurring; a rule that says "do X" without why gets dropped the
first time X is inconvenient.

**Never route a correction to a skill.** The entire problem is that nobody thinks to invoke one.

## Choosing the map

Route to the **codebase map** when the cost is orienting: reads before the first change, the same files
opened at the start of transcript after transcript. The map is injected at session start, so it is the
only destination that arrives *before* someone starts reading, which is the only time it can help.

If the answer is not written down anywhere yet, that is a ticket first and a map entry after.

## Hazards outrank everything

A path holding private data that git neither tracks nor ignores goes first, above every
frequency-ranked finding, however rare. The cost is not proportional to how often it happened; one
`git add -A` is enough. Fix the ignore entry in the same pass, then record why the path exists so the
hole does not reopen.

Untracked, unignored files that are simply new work are **not** a hazard. They are untracked because
they are new. It becomes a finding when a bulk `git add` actually happened while they sat there.

## Dropping

Drop anything that will not recur. The test is "will this happen again," not "did this happen." A report
padded to look thorough teaches the reader to skim, and a skimmed report is worth less than a short one.
Say what was dropped and why, so the judgment is visible and can be argued with.
