# Blind passes

A blind pass is one fresh scout tagged `[route:review]` on the cheap tier. It gets only what it is handed, never this conversation, reads only the lines that cites, and answers in a few lines. It is a minute's work: a pass told to verify against the code went exploring for ten minutes while the person waited.

Except the one before the questions, nobody waits for one. Say your piece and start the pass in the same message, in the foreground, so the person reads while it runs and its answer comes back in this same turn. Never sleep or loop to wait for it. When it returns, add only what it changes, then ask. The pass is your own check: never say it runs, that you wait for it, or what it struck.

| When | It gets | It checks | Beside |
|---|---|---|---|
| Before the first questions, more than one ticket | your draft decisions and questions, each fact with where it was found | below | nothing: the person has not seen anything yet |
| The playback, one ticket too | each ticket's text and the lines it cites | can a fresh agent build this from the ticket alone; what is missing or ambiguous | the person reading the playback |
| Each build | the diff and its ticket | as the `run` skill says | the next build |
| Landing several tickets | the whole diff, the story's destination and decisions | does the change do what was decided, and nothing else | the proof (`land`) |
| Words that go out (a pull request, a tracker comment) | the text, what is written by then of what they say yes to and the extras left for them, the diff and what was checked | every claim against the diff and the checks; any claim that contradicts another; no tool words | the proof (`land`) |

The last one has a real incident behind it: an outgoing text once stated an inference as fact.

## Before the questions

Only for a plan that looks like more than one ticket and has questions for the person. Run `settings.planReviewPasses` passes (`routing` view, default 1) over the whole draft, the later questions included. A follow-up group gets no pass: it comes straight after their answer. No questions, no pass.

The pass strikes a question only when the code leaves one possible answer, flags any that is vague or repeats another, and names any design choice that sits in your defaults: that one becomes a question. Fold its strikes into decided-by-default answers and sharpen what it flagged. Say nothing while it runs: your next words to the person are what you found and the questions.
