---
name: resupply
description: >-
  Turn recent sessions into the capabilities that make the user's goals cheaper to reach: the
  measurement nobody can currently run, the manual work a plugin or skill should own, the knowledge
  that keeps being re-derived, and the setup that keeps pushing back. Use whenever the user asks
  what would make this easier or faster, wonders why something keeps being hard, wants to improve
  their Claude Code setup or workflow, asks what could have gone better, accepts the quartermaster
  nudge, comes off a long or expensive stretch of work, or is starting a goal they have no way to
  verify.
---

# Quartermaster resupply

One question drives this skill: **what is missing from this workspace that would make the user's
goals easier to reach?** Then build or install that one thing, with their approval.

Mining is done by a local script; you interpret its bounded output. Never open raw transcripts
yourself.

## Why capability and not friction

The obvious way to run a pass like this is to hunt for what went wrong: denials, corrections, interrupts,
repeated commands. That is worth doing, and it is the last thing on the list here, because
**removing friction returns the user to par while adding capability moves par.**

The most valuable improvements tend to leave no friction trace at all. When someone needs a
measurement that does not exist yet, nothing errors, nothing gets denied, nobody gets corrected,
and it happens exactly once, so every repetition threshold misses it. A pass that only counts
pain is structurally blind to the highest-value thing it could find.

So lead with what the user is trying to do, and treat the friction counts as one input to that
question rather than the question itself.

## Process

### 1. Name the goal

Before interpreting any numbers, establish what the user has been trying to get done and what
"done" would look like. Everything downstream is ranked against that, and a finding that does not
serve a real goal is noise no matter how well-attested it is.

The mining output shows where the effort went (top commands, attribution, session sizes), so
propose the answer and let the user correct it in one line rather than asking them to write an
essay: "looks like most of the last three weeks went into the ingest pipeline and its tests. What
are you actually trying to get to there?"

Two goal shapes matter, because they take different fixes:

- **A task goal** names a thing to finish: ship the endpoint, migrate the schema, cut the build
  time in half. Progress is visible on its own.
- **A standard goal** names a property to hold: make it reliable, make sure the output is correct,
  make it fast enough. Progress is invisible without a way to measure it, which makes step 4a the
  first place to look.

### 2. Mine

```
node "${CLAUDE_PLUGIN_ROOT}/bin/quartermaster.js" mine --project "${CLAUDE_PROJECT_DIR}"
```

Default window is 30 days / 40 sessions. Add `--all-projects` only if the user asks for a global
pass (much slower). The output is a bounded JSON aggregate: per-session tallies with wall-clock
and prompt counts, top repeated commands, plugin/skill/MCP attribution, web search and fetch
domains, friction counts with a few clipped quotes, and `decisions` with fingerprints of what was
already applied or rejected.

Read it for capability first: **expensive sessions** (high minutes, prompts, and tool calls
together) mark where the goal was hard to reach, and the top commands and fetch domains say what
that expense was spent on.

### 3. Score the last round

```
node "${CLAUDE_PLUGIN_ROOT}/bin/quartermaster.js" verify --project "${CLAUDE_PROJECT_DIR}"
```

Open with one line per earlier decision that has a verdict. Ask two things of each: is it being
used (attribution), and did what it targeted actually get cheaper. Something that went unused or
made no difference is your first finding, as a rollback proposal. Being honest about a
recommendation that did not work is what makes the next one credible.

### 4. Find the gaps

Four questions, in this order. The order is the value order, so spend your attention at the top.

#### 4a. Is there something the user cannot measure?

If they hold a standard goal and no instrument exists to check it, **building that instrument is
the most valuable thing available**, and it usually needs to happen before any fix underneath it.
An unverifiable goal cannot be closed: every change made under it is a guess, and the same ground
gets re-argued in later sessions because nothing settled it.

Tells, none of which show up as friction:

- Long stretches of work on something whose success criterion is a judgement call.
- A property asserted rather than demonstrated: it "should be" correct, fast enough, safe.
- The same question reopened across sessions with a different answer each time.
- A goal the user restates in several sessions without ever calling it done.

The fix is a **measurement built as a skill**, with its scripts committed next to it. The reason
it belongs in the repo rather than a temp directory is simple: if a number will be cited in a
later session, someone will need to re-run the thing that produced it, and a scratch script is
gone by then. A skill that measures makes every later claim about that property checkable in one
command.

Keep the instrument honest about its own limits when you propose it. A measurement built on
whatever data is lying around usually carries a bias (a sample that only includes successes, a
population that is not the real one), and an instrument that names its blind spot is trustworthy
where one that quietly hides it is worse than none.

#### 4b. What is being done by hand that the workspace should own?

Repeated command sequences, hand-rolled scripts written more than once, the same multi-step chore
across sessions. Prefer, in order: an existing plugin, then a skill, then a rule. Plugins are
versioned and removable; skills are yours to shape; rules only ask someone to remember.

Search before building anything:

```
node "${CLAUDE_PLUGIN_ROOT}/bin/quartermaster.js" catalog --query "<terms>"
node "${CLAUDE_PLUGIN_ROOT}/bin/quartermaster.js" catalog --installed
ls .claude/skills/
```

A surprising share of what feels missing is already installed under a name nobody thought of, and
what is genuinely missing turns into a better skill when it reuses what is there.

#### 4c. What knowledge keeps being re-derived?

Repeated exploration of the same code, repeated documentation lookups, facts re-established every
session. Heavy WebSearch or WebFetch on documentation domains with no docs plugin in attribution
is the classic case. This routes to a codebase map doc, a CLAUDE.md line, or a docs plugin.

#### 4d. Where is the setup pushing back?

Now the friction: repeated permission denials on the same safe pattern, corrections clustering on
one theme, tool errors concentrated in one tool, hook errors. Each of these is real and each has a
cheap fix, they just cap out at restoring the speed the user already expected. Note the difference
between `permission-rule` denials (an existing rule is too strict, so allowlist the pattern) and
`user-rejected` denials (the user does not want the action at all, so it is a rule about not doing
it).

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

Seven findings maximum, best first. For each: the evidence, the goal it serves, the exact command
or diff, and the cost (for plugin installs, `claude plugin details <name>` when context cost is
relevant). Wait for an explicit yes or no before touching anything or moving on. Never batch-apply.

If the signals are thin, say so and stop. An empty pass is a valid result, and inventing work to
look useful is how these turn into noise the user learns to skip.

### 7. Record and close

On approval, apply exactly what was shown, then record it. Record rejections too, since that is
what stops the same advice from resurfacing:

```
node "${CLAUDE_PLUGIN_ROOT}/bin/quartermaster.js" decisions add --project "${CLAUDE_PROJECT_DIR}" \
  --title "<short title>" --fingerprint "<kind>:<stable-slug>" --status applied|rejected \
  --kind plugin-install|rule|permission|disable|skill|other \
  --signal denials|interrupts|corrections|toolErrors|any
```

`--signal` is what the next pass verifies against. For a capability that no friction counter
tracks, use `any` and say in the title what to look for instead, so the next pass can ask whether
the new skill or plugin shows up in attribution at all.

Then `node "${CLAUDE_PLUGIN_ROOT}/bin/quartermaster.js" mark-resupply --project
"${CLAUDE_PROJECT_DIR}"` and summarize: what was added, what was declined, and what the next pass
will check.

## Guidelines

- Human in the loop, always. Every install, uninstall, file edit, and settings change gets its own
  approval with the exact change visible first.
- Rank by the goal, not by the count. A single missing measurement can outrank thirty denials, and
  a well-attested annoyance that serves no goal is still noise.
- Seven findings maximum. A pass that surfaces thirty gets skimmed; the tools that tried
  continuous suggestion drowned their users.
- Attribution counts are evidence of use; absence is only a hint. Say "no recorded tool activity in
  the window", never "unused". Hook-only and context-injection plugins legitimately show nothing.
- The miner sees actions, not intentions. It cannot tell you what the user was trying to achieve,
  which is exactly why step 1 asks them.
- Quotes are the user's own words back at them. Keep them short and only where they carry the
  finding.

## Success criteria

- [ ] The user's goal was named before any finding was ranked
- [ ] Mining ran through the script; no raw transcript was opened in context
- [ ] Past decisions were verified and reported before new findings
- [ ] Unmeasurable standard goals were checked for before friction was
- [ ] Existing plugins and skills were searched before anything new was proposed
- [ ] Every proposal showed the exact change and got an explicit yes or no
- [ ] Every decision, including rejections, was recorded with a fingerprint
- [ ] mark-resupply ran at the end
