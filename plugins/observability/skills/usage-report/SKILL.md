---
name: usage-report
description: Answer questions about this project's recorded cost, tokens, tickets, models and routed agents from the usage ledger. Use for "what did this cost", "which category is expensive", "did routing pay off".
---

# Usage report

Answer one question at a time from the ledger. Run the summary script, read its small JSON, say what it shows. Never work out a number yourself and never fill a gap with a guess.

## Run it

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/summarize.mjs" <project path> --by <grouping> [--since <date>] [--top <n>]
```

`<project path>` is the project root (a subfolder works too). A ledger file ending in `.jsonl` works as well. The script reads every ledger of the project: the one file per session this version writes, and the one file per project the older version wrote, rolled-aside files included.

| Question | Arguments |
| --- | --- |
| Cost and tokens per day | `--by day` |
| Tokens per model | `--by model` |
| Cost per kind of work | `--by category` |
| Cost per ticket | `--by ticket` |
| Which turns cost the most | `--top 10` (no `--by`) |
| Routed versus unrouted agents, and the model each ran on | `--by routing` |

`--since` takes a date like `2026-11-01`. For "this week" or "yesterday", work out the date first. Output is capped at 20 rows unless `--top` says otherwise.

## Read the answer

- `recorded: false` means nothing is recorded: the ledger is empty, missing, or has no turns in the range. Say "not recorded", give the `reason`, and say plainly that history only starts once `/track on` is typed in this project, so there is nothing to look back at yet. Ask the one question: record this project from now on? Stop there.
- `error` means the arguments were wrong. Fix them and run again.
- `turnsConsidered` is how many turns the figures cover. Say it, so the reader knows the size of the sample.
- `costUsd` is the sum of the engine's own per-turn cost. `turnsWithoutCost` counts turns where the engine gave no cost. Those turns are not in the sum. Mention it when it is above zero.
- Token fields are `input`, `output`, `cacheRead`, `cacheWrite`.

## What each grouping can and cannot say

- **day** uses the UTC date of each turn.
- **model** has tokens and request counts per model. It has no cost, because the engine reports cost per turn, not per model. Do not split a turn's cost across models.
- **category** and **ticket** attach a turn's whole cost to its one category or ticket. A turn that touched several lands under `(none or mixed)`. Say so when that row is large, since it means the split is partial.
- **routing** counts spawned agents. A spawn is routed when Sidequest published a ticket or category for it. Each row lists `categories`, `requestedModels` and `resolvedModels` as counts. `requestedModels` is what the routing table asked for, `resolvedModels` is what the agent really ran on, and they can differ. The report's `ledgerFiles` lists the files it read.
- If a turn has agents but no routing data, Sidequest was not installed or not publishing then. That is "not recorded", not "unrouted".

## Did routing pay off

Run `--by category` and `--by routing`, then compare cost per category with the models the agents resolved to. Report what the figures show: which categories cost most, which ran on a different model than requested. Do not call routing good or bad from cost alone, since the ledger holds no quality outcome. Say that if asked.

## What the ledger does not hold

Plan limits and the current session's totals are in the built-in `/usage`. Point there for them. Prompt text beyond the first line of a session, code, tool inputs and results are never recorded. For charts across every recorded project, the person runs `/usage-page`.

## Limits

- Read only. Do not edit or delete ledger files.
- Do not switch recording on or off. The person does that with `/track on` and `/track off`.
- Report only the filter you ran. For another cut, run the script again.
