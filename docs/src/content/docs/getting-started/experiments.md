---
title: Experiment loops
description: Run bounded, human-judged comparisons when a person has to decide what works.
---

Use a Sidequest experiment when the result needs human judgement and no test or metric has been shown to reproduce it. For example, a script can render several audio candidates, but a listener still has to decide which one sounds best.

Use an ordinary coding or debugging task when a test or metric can make the decision for you.

## Start an experiment

Tell Claude what you want to compare, how many rounds are worth trying, and what the human should judge:

> Run an experiment to improve this spoken-word render. Use up to four rounds, compare clarity and sibilance, and ask me to judge the candidates blind.

Claude creates the experiment record, sets the round budget, and starts with one clear hypothesis. You do not need to manage branches, refs, log files, or candidate bookkeeping.

## Judge a round

When a candidate is ready, Claude gives you the comparison and asks for a verdict. Judge the output, not the implementation story or the candidate labels. Say what you chose and why:

> B, A, C. B is clearest and has less harshness on the S sounds.

Claude records your words with the round, carries forward useful constraints, and keeps rejected options from being repeated. An accepted result becomes the candidate to carry forward. A rejected or inconclusive result stays recorded as evidence.

## Continue or finish

Ask Claude to continue the experiment when you want another bounded round:

> Continue the render experiment using the last verdict, and change one thing for the next round.

The loop ends when you accept a candidate, spend the declared rounds without finding one, or decide there is no useful direction left. Tell Claude which stopping point applies so the record explains what happened.

## If the loop needs attention

- **The question has an objective answer:** Stop the experiment and ask Claude to turn it into a normal coding or debugging task with a test or metric.
- **The comparison is hard to judge:** Ask Claude to restate the blind question and the decision criteria before you answer.
- **A candidate needs another pass:** Ask Claude to continue from the last verdict and state the one change you want tested.
- **The experiment is going in circles:** Ask Claude to review the recorded constraints and ruled-out options before proposing another round.

See the generated [Sidequest reference](../reference/sidequest/) for the agent-facing experiment workflow.
