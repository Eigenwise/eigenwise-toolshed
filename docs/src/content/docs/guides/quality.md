---
title: How quality is checked
description: There is no separate quality tool. The review that already runs holds a change against what your repository wrote down.
---

<p class="lead">There is no separate quality tool. The review that already runs on finished work checks it against the guidelines your repository wrote down.</p>

## What the review reads

A ticket is one piece of work on the board. Every finished ticket gets one independent, read-only review, except a small one filed as a quick fix. Besides checking that the change does what the ticket says, the reviewer reads three things in your repository:

- **Rules files** in `.claude/rules/` that apply to the files the change touched.
- **A contributing or style page**, if the project has one.
- **Linter and formatter config.** It reads the config. It installs nothing.

## What fails and what does not

| The change | Result |
| --- | --- |
| does not do what the ticket says, breaks something, or claims a check that never ran | **Fail** |
| clearly breaks a guideline written in the repository | **Fail.** The review names the file that states the guideline, the file and line that break it, and the smallest fix. |
| does something the reviewer would have done differently, and nobody wrote that down | **A note** beside a pass |
| breaks a rule that lives only in someone's home folder or memory | **A note** beside a pass |

A failed review sends the ticket back once, with the finding. A second failure stops it.

A fix after a failed review is read again before you are asked to commit. One fresh reviewer gets only the finding and the edits that answer it. A fix nobody read again is never recorded as a pass: the commit question says it was fixed after, not reviewed again.

## Why written rules only

A reviewer's taste changes from one run to the next. A written rule does not. Holding a change to what is written makes the review predictable, and it means a teammate's change is judged by the same rules as yours.

It also keeps the rule in the right place. A rules file in the repository works for everyone who clones it, with or without a plugin.

## The same rules help before the review

Rules files load by themselves for the agent that builds the change, in its own working folder. So most breaks never happen, and the review is the second look.

## When nothing is written down

[Outfit](/why/quartermaster/outfit/) looks for written guidelines when it sets up a project. If it finds none, it offers one thing: to write them down from what the code already does, as short sentences that can be checked. Naming, error handling, test layout, comments.

You see the draft first. On a yes they become rules files. In a team repository they are left in your working folder with the diff shown, for the team to commit its own way.

## Does it work

Measured on a scratch project, over several runs of reviews. Each run used finished changes that passed their tests, and some of them broke one written guideline.

| Reviews | Before | Now |
| --- | --- | --- |
| A change that breaks a written guideline fails the review | 1 of 6 | 10 of 10 |
| A clean change fails wrongly | 0 of 4 | 0 of 8 |

A review takes about 40 seconds, the same as before.

## What it never does

<div class="never">

- It never fails a change over a complexity number or a word count.
- It never enforces a rule from your home folder on the team's code.
- It never installs or runs a linter for you. Your own checks stay your own.

</div>
