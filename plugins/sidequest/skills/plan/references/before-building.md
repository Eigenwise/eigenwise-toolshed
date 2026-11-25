# A step before building

For work with a written step before building.

**Local only.** The story file on the board is the written step. Publish as step 8 of this skill says and name the file (`.sidequest/stories/<story id>.md`) in one line. No hold: building starts on the playback's yes, as always. Nothing below applies.

**The project's own step.** A project can name one step that comes between agreeing the work and building it: `settings.beforeBuilding` in `.sidequest/board.json`, shown by the `routing` view as `before building: <label>. How: ... Read back: ...`. The label is the team's word for it. What the step is, where its result goes and what it looks like are the project's: do what `how` says and add nothing of your own. You own the hand-over, the hold, and bringing the tickets in line afterwards. The rest of this page is that step. A person who asked for a step of their own where the board names none: their words on how to do it stand in for `how`.

## Hand over and hold

Publish as step 8 of this skill says, with two additions.

**The hand-over.** The story's `handOver`: the section `## Hand-over` of `.sidequest/stories/<story id>.md`, where a project's skill reads it. These headings, in this order, each one present, `none` where there is nothing:

- `### Goal`: what and why, short.
- `### Needs first`: what must exist or be decided first, each with who or what it waits on.
- `### Risks`: what could prove hard, the real risks you found and where you found them.
- `### Slices`: one line per ticket, in build order: its title, the files or areas it touches, what done looks like.
- `### Open questions`: each a question with your suggested answer.
- `### Links`: the tracker ticket or user story, code paths, pages read.

Only what the planning established goes in: facts you reproduced or checked, the decisions as agreed, the slices. Anything unknown is an open question, never a guess written as fact.

**The hold.** One more ticket, `kind: review`, `mode: hitl`, titled `<Label> in review`. Every build ticket of the story is `blockedBy` it, so nothing starts.

## Do the step

The step is worked out with the person, here in the conversation. Never hand it to a worker or a scout and never run it in the background; a project's skill may send out agents of its own for legwork. What it writes speaks of the work in the project's terms, with no board id and none of this tool's words in it.

1. `how` names a skill the project has: load it and give it the path of the story file. Otherwise `how` is the instruction: follow it as written. The person's choice of this step covers what `how` says and nothing beyond it.
2. The step gives back an address: a file path, a link. Record it as a decision on the story (`Where is the <label>?`, the answer ending `It is the team's: nobody building changes it.`), so every brief and `land` carry it, and put it in the hold ticket: its title becomes `<Label> in review: <address>`, and its `forYou` asks whether to build now, says under `steps` where the result is, and says that nothing is built until they answer.
3. One line to the person: where it is, and that building starts on their word. Do not load `run`.

## On their go

With a `readBack`: do what it says (a skill, or the instruction). The result as it now reads wins over the tickets: never build what it no longer holds, and never keep a ticket as it was against it. Before any ticket changes or anything starts, tell the person in one short message what differs (a slice or a step gone or added, a question answered, a reviewer's pushback) and how each ticket and its checks would then read. Where their go already settles a difference ("as they changed it"), apply it and say so. Where it does not, or a reviewer pushed back, wait for their word: pushback is theirs to accept or argue. Then change the board from what they settled, before anything runs: a slice that is gone is dropped (`ticket` op `drop`), a new slice is a new ticket, a changed or removed step is a patched `What` or `Done when`, a question answered is a decision on the story, `decidedBy: human`.

With no `readBack`: ask nothing and change nothing.

Then move the hold ticket to `done` and load `run`. When they ask for changes and give no go, keep waiting. When they call it off: `ticket` op `stop` with the story, and one line saying it is parked and why.
