---
title: Experiment loops
description: Run human-judged experiments as bounded Sidequest rounds.
---

Sidequest experiments are for work where a person has to judge the result and no offline metric has been shown to reproduce that judgement. Audio tuning is a useful example: a script can render each candidate, but a listener still has to decide which version sounds better.

If a test or metric can decide the question, use a coding or debugging ticket instead. An experiment ticket keeps the human decision in the loop and records what each round tried.

## File the experiment

Create the ticket with the `experiment` category and a declared round budget:

```text
sidequest add -t "Tune the spoken-word render" \
  --category experiment \
  --rounds 4 \
  -d "Compare four bounded changes to the room tone and sibilance."
```

`--rounds` is the number of rounds you are willing to run. Each round gets one hypothesis. The experiment category also requires every candidate to be committed under `sidequest/experiment/<ref>` and pinned as `refs/sidequest/<ref>/r<N>`, including candidates that lose.

## What happens in a round

Start from the base direction for the first round. Later rounds continue from the prior candidate ref, such as `refs/sidequest/SQ-123/r1`. Make one change, render or otherwise produce the candidate, and record the result in the experiment log. Keep the comparison blind and ranked so the human is judging the output rather than the label or implementation story.

A round's log entry records the hypothesis, change, commit and branch, measured result, deliverable, verdict, failure reason, constraint bought, and status. The log also keeps ruled-out options and standing constraints so the next round does not repeat old work.

Sidequest creates an experiment log asset for the ticket. When a new round is briefed, the executor receives the log path and a bounded packet from that log before its first edit. Read the full asset before starting the round. The briefing also names the checkout target, including the prior `refs/sidequest/<ref>/r<N>` pin when continuing.

## Ask the oracle

When a candidate is ready for a human, hand off the active round with its blind comparison question. Keep the ticket in `doing` and include the candidate pin and deliverable when they help the person judge it:

```text
sidequest release SQ-123 \
  --status doing \
  --oracle "Rank these renders A, B, and C from best to worst for clear speech, without seeing which change produced each one." \
  --candidate refs/sidequest/SQ-123/r2 \
  --deliverable artifacts/audio-tuning-r2/
```

`--oracle` is the question the human answers. `--candidate` identifies the pinned candidate, and `--deliverable` points to the thing they should listen to, view, or otherwise inspect. The ticket stays active while it waits for the answer.

## Record the verdict

Record the human's words exactly. Choose `accepted`, `rejected`, or `inconclusive`; `--why` and `--constraint` are optional notes for the experiment log.

```text
sidequest verdict SQ-123 \
  --text "B, A, C. B is the clearest, with less harshness on the S sounds." \
  --outcome accepted \
  --why "The ranking favored clarity and comfort, not loudness." \
  --constraint "Keep the high-frequency cut that reduced harshness."
```

The verdict updates the current round in the experiment log and clears the pending oracle ask. An accepted candidate is marked `accepted`; a rejected candidate is marked `DO-NOT-MERGE`; an inconclusive result stays explicitly inconclusive. The original verdict text remains quoted in the log, without paraphrasing.

## Where the record lives

The ticket's experiment asset is named `experiment-<ref>.md`. It contains the round history, ruled-out options, and standing constraints. Candidate commits live under `sidequest/experiment/<ref>`, with round pins at `refs/sidequest/<ref>/r<N>`.

## How the loop ends

The loop ends when the human accepts a candidate. The accepted candidate is the one to carry forward.

It can also end without an accepted candidate: a candidate is rejected or inconclusive and the remaining declared rounds are spent, or the human and operator decide there is no useful direction left. Keep the final verdict and the reason in the log so the next attempt starts with the actual evidence.
