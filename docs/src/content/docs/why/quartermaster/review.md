---
title: 'Review: did it help?'
description: Review looks at each applied change and asks whether it was used and whether its check moved. Then you keep it, improve it or roll it back.
---

<p class="lead">A change that nobody uses is clutter. Review finds those, and removing one is a normal outcome.</p>

## Why it exists

Most tools only ever add. A rule gets written, a skill gets installed, and nobody checks whether it did anything. A year later the setup is full of things that load every session and help nobody.

Every Quartermaster proposal carries a check with a number. Review reads that number again.

## Start it

```text
/quartermaster:review
```

Quartermaster also offers a review by itself, 3 sessions after a change landed, with one offer for every change that is due. It is one offer per session, at a real pause, it waits 3 days, then 6, then twice as long when ignored, and an offer starts nothing.

## The ladder

Each applied change sits on one of four rungs.

| Rung | Meaning |
| --- | --- |
| **applied** | The files still hold the change. |
| **loaded** | The skill, rule, plugin or setting is visible in this session. |
| **exercised** | It was used after it landed. A skill ran. A rule's files were worked on. A permitted command ran with no prompt. |
| **useful** | Its check moved the right way from the baseline. |

Review moves each change up the rungs it has reached, one at a time.

## What you are asked

Only where the evidence says something.

| What the evidence shows | What review recommends |
| --- | --- |
| Used, and the check moved the right way | Keep |
| Used, and the check is flat or worse | Improve, with one line on what to change. Or roll back. |
| Never used after enough sessions | A failed trial. It offers the rollback. |
| Fewer than three sessions since the change | Too early. It is listed as waiting and you are asked nothing. |

Each question is worded so that "yes" accepts the recommendation.

## Rolling back

Before any change was made, the bytes of every file it touched were saved in `.claude/quartermaster/changes/`. A rollback restores those files and names any new files the change created, so you can delete them.

It only restores a file that still holds what the change wrote. A file someone edited since is left alone and named, with the difference, so a later edit is never overwritten. You undo that part by hand.

A plugin install is the one case that needs a command as well: the rollback tells you the uninstall command to run.

## What it never does

<div class="never">

- It never reads silence as "keep". No answer is recorded as no answer.
- It never judges a change too early.
- It never rolls back by itself. You say so.

</div>
