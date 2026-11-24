---
name: plan
description: Use for a feature, a reported problem or a new project that needs the human's decisions, or when they ask for a step of their own before anything is built (a written plan, a design note). Reads the whole request and the code, shows what it found with the options, grills, then files tickets.
---

# Plan

Turn a request into a plan the human agreed to, then into tickets. The stops, one message each: what you found, with the first few questions that are the person's; a follow-up when an answer opens a new decision; the plan and the tickets, for one yes. With nothing that is the person's, what you found and the plan are one stop. A correction at any point is folded in before you go on, and is never the yes. Facts are your job. Decisions are theirs. The agents that build it start fresh from the tickets.

You orchestrate; scouts do the legwork, one sharp question each: `[route:explore]` reads the codebase, `[route:research]` anything outside it.

```
Agent({ subagent_type: "sidequest:scout", description: "How retries work today",
  prompt: "[route:explore] Find how failed uploads are retried today and which tests cover it. ..." })
```

Real digging (a reproduction, a measurement) goes on the board first as a `research` ticket, started with `mcp__sidequest__start`. Say in one line what is being looked at, in the project's own words, and show what it found before you use it. How you work stays out of what you say: no scout, no pass, no check of your own draft, no model name. The pane shows who runs on what.

## 0. Read first

Reading changes nothing, so it needs no permission, and nobody can judge a course before they know what you know. The first thing the person gets is what you found (section 4), never a way of working to agree. Say in one line what you are reading, then read:

- **The board, once.** The `planning` view has the settings, the stories and the open tickets: the only board call before your first message, no `now` and no `summary` beside it. A story that already covers this changes everything.
- **The whole request.** A tracker issue is its description, its comments, the issues it links and every attachment: ask the tracker for them even when the text mentions none. Fetch each one with whatever reads that tracker here and open every image: a mockup or a screenshot often says what the text leaves out. One you cannot fetch or open (a recording, a format nothing here reads) is named in your first message, with the question what it shows. Never plan from the text while an image went unread.
- **The code** it touches, as section 1 says, and what the project wrote down about it (its rules, its docs, its notes).

**Read in two waves, each one message in the foreground:**

1. The board and the issue with its links and attachments, together.
2. From what the issue says: every area of code, the outside docs and a probe, together. Read a small area yourself in that same message; give a scout only an area too large to read in a call or two, with a brief of a minute or two.

Each wave comes back in the same turn. Never read in the background, since each return wakes you again, and never one call after another, since that is what makes the wait. You read only what you need to put their answers together.

What the team would see, or closing this conversation would not undo (a tracker status, a branch, a commit, a comment), is not reading: it waits for its own yes.

**The first message is due in about three minutes** for a change that looks like one ticket: the two waves of reading, nothing more. A check that takes longer (a probe of every model, a slow reproduction) does not hold the message back: send what you know, say in one line what is still being checked, and bring its result with the next thing you say. Silence leaves a developer wondering whether anything is happening.

## 1. Find out what is true

- **A reported problem** is made to fail first, unless the request says to start another way. A reproduction that failed on demand in this conversation, or that an earlier run left on disk and fails again, is enough; otherwise a research ticket makes it fail, then scouts find the cause unless the reproduction shows it. One that needs something shared (the `planning` view names them) or changes data they keep is asked first. If it will not fail, say what was tried and ask for what is missing; with nothing more, offer one small ticket that captures the next failure, or parking it. Never ship a guessed fix. When they ask for the failing test first, the first ticket writes the test that fails today (a build ticket: a scout writes nothing in the project) and the fix is blocked by it.
- **A feature**: the code it touches is read, as section 0 says.
- **An empty project**: there is no code to read, see A new project in `references/slicing.md`.

## 2. Lay out the options

The approaches that would work. For each one: where it lands in the code (`file:line`), what changes there, why it works, what it costs. Then your recommendation. Where they differ in a choice that is the person's, that difference is a question in section 5 with your recommended answer, never a pick you report.

Say where the request contradicts the code, an attachment or an earlier decision, is bigger than the problem needs, or has a cheaper route.

Then say what they may not have thought of: edge cases, how it fails, what it makes harder later.

## 3. Check feasibility

When a part is in real doubt (a library, an API, behaviour nobody has seen yet), prove it cheaply before anyone commits: a scout reads the library or API in question, or runs a throwaway probe. Say what was proven, what was not, and what changes if it fails. When nothing is in doubt, say so in one line and run no probe.

## 4. The first message

Write it once, on the story. Create the story (`mcp__sidequest__ticket`, `story`) with its short version as `inShort` (a finding that is one of the decisions stays out: the decision says it) and its `analysis` in this order: what is asked (and what each image shows), how it works today (for a problem, how you made it fail and the cause), what surprised you (section 2), then the options under a heading `Options`, lettered A, B, C, each with where it lands and what it costs. Never number an option: numbers are for decisions. When the options differ only in a choice that is the first decision, tell it once, as that decision, and leave it out of the options. In the same call give the path through the code as `path`, the code that matters as `excerpts`, and the first group of questions (section 5) as `questions`. Path and excerpts are data the board draws: never draw them with typed characters. No tables (the pane is narrow: one list line per row).

Then say in the chat exactly what the tool's reply hands you, in the shape it names: with the board pane placed, your two sentences above its pointer line and nothing else; with no board, its text as it is. Never write the analysis, the options or the decisions into the chat yourself: the person reads them in one place. Say what a thing does before you use its name. Never point at the plan by an id or a file path.

With nothing that is the person's, the playback (section 8) follows in the same message. A change in one place with nothing to choose needs no long form either: what you found is three or four lines, and the story is created when you publish.

## 5. Grill

Follow `references/grilling.md`. Ask only what changes what gets built, and only what the rule there says is the person's. Never ask how it gets executed or shipped.

**With a person here on work that changes code, the design is theirs too**: the choices a reviewer would argue about on the pull request, because their name goes on it. Each of these gets asked when this change has one, though never all in one list:

- **The interface**: every new name, type and shape other code or a client will see, and what it does with bad input. Asked even when the request seems to name it: a convention narrows the answer, it rarely leaves one.
- **Where the behaviour lives**, when more than one place is defensible.
- **What is left out** on purpose.
- **The seam it is tested at**, and the tests by name.

Only what the code leaves one possible answer for is a fact: say it with where you found it, never ask it. What no reviewer would argue about (a local name, a helper, the order of the edits) is yours and goes unsaid.

Ask them before any plan, the way a colleague works a design out with them, never like a form. Start with a small group: the few questions that can be answered now and belong together, beginning with what the others hang off. That is usually the interface, because where the behaviour lives and how it is tested follow from its shape. A question whose answer depends on one still open waits. When the answers come, say in one line what they settle or change, then ask what they opened (they want it cached: for how long, and what clears it). Never ask what an answer already settled or made obvious. There is no fixed number and no second group for its own sake: when nothing is left open, go to the playback. "You decide" ends it at once.

An answer to the questions settles the questions and nothing else, however eager it reads ("go on and implement it as you suggest", "ok go on"): they agreed to answers and have not seen the tickets. Nothing is filed or started on it, and the playback comes next. Work they add in an answer ("and do a cleanup pass") has a scope nobody agreed: it goes into the playback as its own ticket block, with the scope you would give it, for them to cut or widen.

A group is written to the story as `questions` before it is shown, and the chat says what the reply hands you, as section 4 says. Each question gives the question in a line, your recommended answer written the way the code will read (`retries: number`, `sendReceipt(order)`; several parts as a list; code in backticks, prose plain, one part too), and in `otherCosts` the other answer and what it costs; the reasoning (`file:line`) sits in the analysis. A follow-up group replaces the story's `questions` the same way. When an answer comes, record it as a decision on the story and patch `questions` without it. Never a list of what you decided. What you took by default waits for the playback.

A plan that looks like one ticket gets no blind pass before the questions: the person is right there to answer. When it looks like more than one ticket and there are questions for the person, read `references/blind-passes.md` and run the pass it describes before they see the first group. Work the asked-for result depends on stays in the story as a default they can turn off; only work it does not depend on goes to the inbox.

## 6. Agree how it gets delivered

In the last grill round, once per story, as How it gets delivered in `references/slicing.md` lays out. Skip it for one ticket, or when the request or an earlier story already says: record that as a default. The playback states where it ends: never ask that here.

## 7. Record and slice

Complete the story you created with the analysis: the **destination** (what is true when this is done), the **decisions** (`D-1`, `D-2`, ... each with the question, the answer, and who decided: `human` or `default`), and what is **out of scope**. Slice it into tickets by `references/slicing.md`, which also says how checks and shared things shape a ticket.

When the plan has the project's own step, `references/before-building.md` governs from here on.

## 8. Play back, then publish

Never skip it. The playback carries no open question: ask it first, or take it as a default. Once answered, say in a line that you are writing the tickets, then file them in two `mcp__sidequest__ticket` calls so no id is guessed: one patches the story (destination, decisions with your defaults, proof and delivery, out of scope, `awaitsYes: true`) and creates every ticket under it, `ready`, its own text with its technical plan (Play them back, `references/slicing.md`); the next sets `blockedBy` from the first reply's ids. Then say what the reply hands you (section 4). With no board, one message, in this order, each item a line one word changes:

1. The destination.
2. What you took by default, a line each; nothing they just answered is said again.
3. How it is proven on the real thing, and where it ends: a branch, a PR, or the delivery rule an earlier story recorded.
4. How it gets delivered.
5. With a `before building:` line in the `planning` view: whether you would do that step for work of this size. It needs a person, so never pick it with nobody here; it is done after the yes.
6. The ticket blocks the reply gave, as they are, then who does what.
7. The question: are the plan and slicing right?

A stop or not now is `stop` with the story: it parks them.

In the same message, for one ticket too, start the blind pass on the ticket text (`references/blind-passes.md`); when it returns, add only what it changes. These lines become decisions on the story, so a later session and `land` never ask again.

An approval the project's rules ask for before a commit or a push comes after the build, in `land`: nobody can approve code that does not exist yet.

That yes is the only one, and no ticket of the plan starts before it. These are not it: a go-ahead given earlier in an answer to the questions, and a reply that corrects the plan (patch the tickets, play back what changed, ask again). "You decide" settles the open questions as decided by `default` and nothing else: it never skips the slicing or this playback.

On the yes, publish: patch the story `awaitsYes: false`, and its tickets are live. Load the `run` skill and go. With the project's own step, the story is published with its `handOver` and behind a hold ticket, the step is done, and nothing starts.

After that yes, never ask a go-ahead question again. Dispatch, retries and the PR are yours, and the merge when the `land` skill says it is. A checkpoint, or the hold of a step before building, is the one planned stop.
