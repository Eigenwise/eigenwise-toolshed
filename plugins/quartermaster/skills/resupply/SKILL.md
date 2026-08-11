---
name: resupply
description: >-
  Work out what a workspace is short of and get it: a measurement nobody can run yet, work being
  done by hand that a plugin or skill should own, knowledge that keeps being re-derived, and the
  setup pushing back. Reads recent sessions for what the user was actually working toward, then
  proposes one item at a time for approval. Use whenever the user asks what would make this easier
  or faster, what they are missing, why something keeps being hard, or what could have gone better;
  when they want to improve their Claude Code setup, tooling, or workflow; when they accept the
  quartermaster nudge; after a long or expensive stretch of work; or when they are starting a goal
  they have no way to verify.
---

# Quartermaster resupply

One question drives this skill: **what is this workspace short of that would make the user's work
easier?** Then get that one thing, with their approval.

A local script does the mining and hands you a bounded aggregate. Never open raw transcripts
yourself: they run to tens of megabytes, and the aggregate already carries what matters.

## Why capability and not friction

The obvious way to do this is to hunt for what went wrong: denials, corrections, interrupts,
commands retyped by hand. That is worth doing, and it is the last thing on the list here, because
**removing friction returns the user to par while adding capability moves par.**

The improvements that matter most tend to leave no friction trace at all. When someone needs a
measurement that does not exist yet, nothing errors, nothing gets denied, nobody gets corrected,
and it happens exactly once, so every repetition threshold misses it. A pass that only counts pain
is structurally blind to the most valuable thing it could find.

So lead with what the user was trying to do, and treat the friction counts as one input to that
question rather than the question itself.

## Process

### 1. Mine

```
node "${CLAUDE_PLUGIN_ROOT}/bin/quartermaster.js" mine --project "${CLAUDE_PROJECT_DIR}"
```

Default window is 30 days / 40 sessions. Add `--all-projects` only if the user asks for a global
pass (much slower). Everything below reads from this one output.

### 2. Read what the work was for

The aggregate tells you this directly, so do not open with an interview. Each entry in `sessions`
carries `title` (the session's own one-line summary), `openingAsk` (its first real prompt), `goal`
(an explicit `/goal` with whether it was ever `met`), and `humanDriven`. `purpose.goals` totals the
goals set and met, and `purpose.areasTop` shows which parts of the tree the work landed in.

Weigh them like this:

- **An explicit `goal` is the strongest signal**, because it is the user stating a standard in their
  own words. It is also the rarest by a wide margin, so its absence means nothing at all.
- **`title` and `openingAsk` carry most sessions.** They agree more often than not; where they
  diverge, the title reflects where the work went and the opening ask reflects what was wanted.
- **Rank by effort, never by count.** Sort `sessions` by `toolCalls` and `minutes`. Ten one-prompt
  sessions are not ten times more important than the marathon that actually moved the work.
- **Ignore `humanDriven: false` sessions when reading purpose.** Those are hook- or
  harness-spawned. Their titles state that machinery's job, and there are often far more of them
  than real sessions, so counting titles without this filter reports the automation back to the
  user as their own goal.
- **A session with hundreds of prompts and a span of days is a container, not a task.** It was
  resumed repeatedly, and its title describes only its opening subject. For those, `goal`,
  `areasTop`, and the top commands say far more about purpose than the title does.

Then state your read in one or two lines and let the user correct it, rather than asking them to
explain themselves from scratch: "the last three weeks look like they went into the ingest path and
its tests, with an open goal about it not dropping rows. Is that still what matters?" Only fall back
to a real question when the signals are genuinely thin or contradictory.

Two goal shapes matter, because they need different things:

- **A task goal** names something to finish: ship the feature, migrate the store, cut the build
  time. Progress on it is visible on its own.
- **A standard goal** names a property that must hold: make it reliable, make sure the output is
  correct, make it fast enough. Progress is invisible without a way to measure it, which puts step
  4a first.

**An unmet goal is the single best lead in the whole aggregate.** `purpose.goals` reporting a goal
set and never met, especially one restated across sessions, means the user asked for something and
the workspace could not deliver it. Start there.

### 3. Score the last round

```
node "${CLAUDE_PLUGIN_ROOT}/bin/quartermaster.js" verify --project "${CLAUDE_PROJECT_DIR}"
```

Open with one line per earlier decision that has a verdict. Ask two things of each: is it being
used (`attribution`), and did what it targeted actually get cheaper. Something unused or making no
difference is your first finding, as a rollback. Being honest about a recommendation that did not
work is what makes the next one credible.

### 4. Find the gaps

Four questions, in value order. Spend your attention at the top.

#### 4a. Is there something the user cannot measure?

If they hold a standard goal and nothing can check it, **building that instrument is the most
valuable thing available**, and it usually has to happen before any fix underneath it. An
unverifiable goal cannot be closed: every change made under it is a guess, and the same ground gets
re-argued later because nothing settled it.

Tells, none of which appear as friction:

- A goal set and never met, or restated across several sessions.
- Long stretches of effort on something whose success criterion is a judgement call.
- A property asserted rather than demonstrated: it "should be" correct, fast enough, safe.
- The same question reopened across sessions with a different answer each time.

The fix is a **measurement built as a skill**, with its scripts committed beside it. A number that
will be cited later needs something re-runnable behind it, and a scratch script is gone by then.
This holds outside code too: whether a document covers what it claims, whether an export matches
its source, whether a config still matches what is deployed.

Have the instrument state its own limits when you propose it. A measurement built on whatever data
was available usually carries a bias (a sample that only includes successes, a population that is
not the real one), and one that names its blind spot can be trusted where one that hides it is
worse than nothing.

#### 4b. What is being done by hand that the workspace should own?

Repeated command sequences, hand-rolled scripts written more than once, the same multi-step chore
across sessions. Prefer, in order: an existing plugin, then a skill, then a rule. Plugins are
versioned and removable; skills are yours to shape; rules only ask someone to remember.

Search before building anything:

```
node "${CLAUDE_PLUGIN_ROOT}/bin/quartermaster.js" catalog --query "<terms>"
node "${CLAUDE_PLUGIN_ROOT}/bin/quartermaster.js" catalog --installed
```

Then list what the project already has (`.claude/skills/`, `.claude/commands/`). A surprising share
of what feels missing is already installed under a name nobody thought of, and what is genuinely
missing turns into a better skill when it reuses what is there.

#### 4c. What knowledge keeps being re-derived?

The same material re-explored, the same lookups repeated, facts re-established every session. Heavy
`webSearches` or `webFetchDomainsTop` on documentation with no docs plugin in attribution is the
classic case. This routes to a project-knowledge destination: a codebase-mapper doc if that plugin
is installed, otherwise `CLAUDE.md`.

#### 4d. Where is the setup pushing back?

Now the friction: repeated denials on the same safe pattern, corrections clustering on one theme,
tool errors concentrated in one tool, hook errors. Each is real and each has a cheap fix; they just
cap out at restoring the speed the user already expected. Note the difference between
`permission-rule` denials (a rule is too strict, so allowlist the pattern) and `user-rejected`
denials (the user does not want the action at all, so it is a rule about not doing it).

### 5. Route

Map each finding to exactly one destination using [references/routing.md](references/routing.md).
Prefer the highest destination that fits: installable things beat written rules, and written rules
beat asking someone to remember.

New skills go through **skill-creator**. A hand-rolled SKILL.md tends to encode the one example in
front of you instead of the general shape, and its description ends up too vague to trigger when it
is needed. If skill-creator is not installed, that install is the finding; point the user at the
official marketplace and `/reload-plugins`.

Drop any finding whose fingerprint sits in `decisions.rejected`. The user already said no; do not
re-litigate unless they raise it.

### 6. Propose, one at a time

Seven findings maximum, best first. For each: the evidence, the purpose it serves, the exact command
or diff, and the cost (for plugin installs, `claude plugin details <name>` when context cost is
relevant). Wait for an explicit yes or no before touching anything or moving on. Never batch-apply.

If the signals are thin, say so and stop. Proposing nothing is a valid outcome, and inventing work
to look useful is how these passes turn into noise the user learns to skip.

### 7. Record and close

On approval, apply exactly what was shown, then record it. Record rejections too, since that is
what stops the same advice from resurfacing:

```
node "${CLAUDE_PLUGIN_ROOT}/bin/quartermaster.js" decisions add --project "${CLAUDE_PROJECT_DIR}" \
  --title "<short title>" --fingerprint "<kind>:<stable-slug>" --status applied|rejected \
  --kind plugin-install|rule|permission|disable|skill|other \
  --signal denials|interrupts|corrections|toolErrors|any
```

`--signal` is what the next pass verifies against. For a capability no friction counter tracks, use
`any` and say in the title what to look for, so the next pass can ask whether the new skill or
plugin shows up in attribution at all.

Then `node "${CLAUDE_PLUGIN_ROOT}/bin/quartermaster.js" mark-resupply --project
"${CLAUDE_PROJECT_DIR}"` and summarize: what was added, what was declined, and what the next pass
will check.

## Guidelines

- Human in the loop, always. Every install, uninstall, file edit, and settings change gets its own
  approval with the exact change visible first.
- Rank by the purpose, not by the count. A single missing measurement can outrank thirty denials,
  and a well-attested annoyance that serves no goal is still noise.
- Seven findings maximum. A pass that surfaces thirty gets skimmed; the tools that tried continuous
  suggestion drowned their users.
- Nothing here assumes a codebase. A notes vault, an infrastructure repo, or a writing project has
  standards it cannot check and chores done by hand just as much; only the instruments differ.
- Attribution counts are evidence of use; absence is only a hint. Say "no recorded tool activity in
  the window", never "unused". Hook-only and context-injection plugins legitimately show nothing.
- Quotes and titles are the user's own words back at them. Keep them short and only where they
  carry the finding.

## Success criteria

- [ ] Mining ran through the script; no raw transcript was opened in context
- [ ] Purpose was read from the aggregate and put to the user, not asked for cold
- [ ] Sessions were weighed by effort, with `humanDriven: false` excluded from the purpose read
- [ ] Past decisions were verified and reported before new findings
- [ ] Unmeasurable standard goals were checked for before friction was
- [ ] Existing plugins and skills were searched before anything new was proposed
- [ ] Every proposal showed the exact change and got an explicit yes or no
- [ ] Every decision, including rejections, was recorded with a fingerprint
- [ ] mark-resupply ran at the end
