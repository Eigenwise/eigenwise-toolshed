# Experiment loops

Use the `experiment` category only when **the verdict is a human's judgement and no offline metric has been shown to reproduce it.** If a test can decide, use coding or debugging instead.

## One round at a time

An experiment is one ticket with a declared round budget, filed with `add --rounds`. Each round gets a fresh executor and follows this loop:

1. Dispatch the ticket. The briefing carries the experiment log and names the base or prior candidate to inspect.
2. The executor reads the log, tests one hypothesis, and commits the candidate ALWAYS, including a candidate expected to lose.
3. It releases with `release --status doing --oracle "<the ask>" [--candidate <hash>] [--deliverable <path>]`.
4. The user judges the deliverable while no executor is alive.
5. Record the result with `verdict <ref> --text "<verbatim>" --outcome accepted|rejected|inconclusive [--why] [--constraint]`, then dispatch the next round.

The round number is the dispatch launch sequence. The log is append-only: keep ruled-out approaches, standing constraints, and each round's hypothesis, change, measured baseline, deliverable, verdict, and status. A correction appends a new entry and marks the old one overturned; never edit history.

The round budget is a timebox, not a target to ignore. Hitting it requires either an explicit extension with a reason or closure with the ruled-out map and standing constraints. `add --rounds` ships separately as the round-budget option.

## Branches and promotion

Round work persists through git, not a worktree. Use one long-lived `sidequest/experiment/<ref>` branch, and pin every candidate as `refs/sidequest/<ref>/r<N>`. Never discard a rejected candidate. The next briefing names the exact base or ref to continue from.

Promotion requires an accepted verdict on the exact commit being promoted. A measurement never qualifies by itself. Cherry-pick that candidate onto the integration branch only after the log entry for that exact commit reads `accepted`.

Experiments have two valid terminal shapes:

- **Criteria found:** merge the accepted candidate and promote its standing constraints to a durable home, such as a project live rule or `CLAUDE.md`.
- **Budget exhausted:** close successfully with no accepted candidate when the round budget is spent; the deliverable is the ruled-out map plus standing constraints.

## Oracle rules

The executor writes the oracle ask because it built the deliverable. Make it a blind ranked comparison, such as “Rank rows 3, 4, 5 best to worst,” rather than “does this sound better.” Keep the user's verdict verbatim in `--text`. Put the orchestrator's interpretation in `--why`, and any earned rule in `--constraint`; never paraphrase the quoted words.
