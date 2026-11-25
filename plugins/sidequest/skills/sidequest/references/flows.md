# Sample flows

Six examples of a plan. Every project and every request is different, so take the shape that fits and change it. What stays the same: plan first, find out before asking, the human decides what gets built, significant work goes through the board, and the result is proven on the real thing.

## A bug in something people use through a screen

1. **Plan.** The report, what done looks like, and what this project has for driving a browser and reading its data.
2. **Reproduce.** A `research` ticket: a scout opens the app in the browser and follows the reported steps until it fails, then hands back the steps, the failure and how often it happened.
3. **Find the cause.** Scouts read the code path the reproduction went through.
4. **Options and the human.** The `sidequest:plan` skill: where each fix lands, what it costs, what they may not have thought of, a feasibility check on the risky part, then the questions.
5. **Fix.** Tickets, each with a check that fails today. Usually one.
6. **Land**, with one verify run.
7. **Prove it.** The same browser steps, against the landed fix, now pass. Show the human what you saw.

## A feature

1. **Plan**, including what the human will be able to do when it is done.
2. **Read the code** it touches, with scouts in parallel.
3. **Options, feasibility, questions**, and how they want it delivered: in checkpoints or all at once.
4. **Slice.** With checkpoints, the first slice is usually the screens and the whole flow on dummy data, so they can react before the real logic exists.
5. **Run and land** each slice. At a checkpoint, start it yourself and say where to look.
6. **Prove it.** Walk the finished feature the way a user would, start to end.

There is nothing to reproduce. Show the current behaviour first instead, so the conversation is about something everyone can see.

## A clear change with several parts, built here

The request is clear but has more than one behaviour, like a new field, two endpoints and a changed rule.

1. **Plan**, saying you build it yourself or route its parts.
2. **One ticket** for the whole piece, `doing`, before the first edit. Notes go on its log as you go.
3. **Build and check** it on the real thing.
4. **A second reader**, one scout on the mid tier, tries to break it (`routing.md`). Fix what it finds.
5. **Close** the ticket with how it was checked.

A batch of the same kind, like eight branches to triage, gets the one ticket and no reader.

## A new project

1. **Plan** from what it is for.
2. **Research** how such a thing is usually built and which stacks are realistic.
3. **Decide with the human**: stack, shape, what the first version leaves out.
4. **Walking skeleton**: the thinnest thing that builds, starts and passes one real check. It is the first ticket, even when the human said "you decide".
5. **Play the plan back**: the skeleton, the tickets after it and what is left out, in one message. Publish nothing before the human's yes.
6. Then features, as above.

## A knowledge base, a notes vault, or documents

There is no code and often no test command. The flow still holds; the words change.

1. **Plan.** Which notes, what structure, who reads the result.
2. **Find out.** Scouts read and search the vault: what already exists on this, what contradicts what, where the sources are.
3. **Decide with the human** what gets written, merged, moved or removed. Which of two notes that disagree is true is the human's call, never yours. With no git, ask before deleting or overwriting a note, or keep a copy and say where.
4. **Tickets**, one per outcome a reader would notice: a note written, a section restructured, a set of links repaired.
5. **Prove it** by reading the result as its reader would: links resolve, each claim has its source, nothing now contradicts another note, the note can be found from where someone would look.

Without git there are no worktrees and nothing to merge: set `settings.worktrees` to false, run workers one at a time, and a ticket is done when its check passes.

## A question

Someone wants to know something. Nothing gets built.

1. **Plan** what would count as an answer.
2. **A scout** for a quick lookup, a `research` ticket for real digging.
3. **Answer** with where each part came from, and say what you could not confirm.
