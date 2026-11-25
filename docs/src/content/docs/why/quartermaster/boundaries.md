---
title: Where it stops
description: Quartermaster proposes, configures and improves. It owns no runtime gate, no scoring and no orchestration.
---

<p class="lead">Quartermaster sets things up and improves them. It does not run your work, judge your code or stand in the way of a tool call.</p>

## Why draw the line

A tool that sets up your workspace is tempting to grow. It already sees everything, so why not have it enforce the rules, score the code and run the tasks too?

Because then one tool holds all the power, and a fault in it stops everything. The older version went that way, one reasonable safety check at a time, until it slowed the work it was meant to help.

So the line is fixed.

## What Quartermaster owns

- **Setup.** Looking at a project, choosing what fits, installing and configuring it, checking that it loaded.
- **Improvement.** Noticing, proposing, applying on your yes, and checking later whether it helped.
- **The records** of all of that: proposals, changes, rejections.

## What belongs to someone else

| This job | Belongs to | Why not Quartermaster |
| --- | --- | --- |
| Running work, agents and the board, the list of work | [Sidequest](/why/sidequest/) | Setup and execution fail in different ways. Keep them apart. |
| Rules that apply while you work | [Live Rules](/why/live-rules/) and Claude Code itself | A rule is a plain file Claude Code loads. Nothing needs to enforce it. |
| Checking a change against the project's guidelines | [Sidequest's review](/guides/quality/) | Quartermaster can write guidelines down. Holding work to them is part of running work. |
| Knowing the layout of the code | [Codebase Mapper](/why/codebase-mapper/) | The map is project knowledge. It should work with Quartermaster gone. |
| Usage and cost records | [Observability](/why/observability/) | A record of what each turn cost is its own job, and it works with Quartermaster absent. |

Quartermaster can install and configure any of these. It can read their results. It never does their job for them.

## Three things it will not become

<div class="never">

- **A gate.** It never blocks a tool call, a prompt or a stop. Its hooks fail open: when one breaks, your work carries on.
- **A scorer.** No friction score, no quality score. A candidate is a count you can read, and a verdict is a count against a baseline.
- **An orchestrator.** It starts no agents to do your tasks.

</div>

## The test for a new idea

A new gate, guard or setting gets into any Toolshed plugin only when two things are true. A real failure happened without it. And it makes you faster.

An idea that fails that test gets a dated note saying why it was declined, so it is not argued from scratch a month later.
