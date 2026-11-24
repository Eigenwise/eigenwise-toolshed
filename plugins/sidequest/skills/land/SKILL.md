---
name: land
description: Use when reviewed run branches are ready to come home. Merges them into one integration branch (one ticket lands on its own), verifies the composed tree once, records the result and opens the PR.
---

# Land

Bring every reviewed branch home, prove the composition works, and record what git says. You land the work yourself, with no go-ahead question.

The project's own rules come first. When its instructions or skills cover branches, commits, pull requests, tracker updates or release notes, deliver through them and keep their approval steps.

The board is yours alone. Nothing that leaves this machine or that a colleague reads (a branch name, a commit or merge message, PR text, a tracker or PR comment, a committed file) names the board, a board id, this tool or its words (worker, scout, wave, brief). It speaks of the work in the project's terms: the tracker key where there is one, the behaviour that changed, how it was checked.

## Steps

1. **Collect.** `mcp__sidequest__board` lists tickets in `review` whose last review note is `review pass` or `review skipped`. Each ticket log names its branch.
2. **Integrate.** Commit your own pending edits for this story first. One ticket with its own branch lands on that branch, renamed the project's way first when an agent's host named it. More than one: create one integration branch from the up-to-date default branch, named the project's way and carrying the tracker's issue key when the story has one, and merge each reviewed branch into it, one at a time, each merge message saying what that work does. When the main checkout holds changes that are not this story's, leave it alone (never commit, stash or switch away from someone's work in progress) and do this step and the verify in a fresh worktree: `git worktree add --detach .claude/worktrees/land-<story> <ticket or default branch>`.
3. **Read the diff stat.** Revert files no ticket asked for, or explain them in the PR.
4. **Verify once.** Run the board's `settings.verify` command (`mcp__sidequest__board` view `routing` shows it) on the landing branch, in the main checkout or step 2's worktree, never in one an agent used. Check out a branch an agent's worktree holds with `--detach`. A verify that needs a file only the person's checkout has is `not measured`, with why. A landing branch that carries code an `outside-code` ticket passed is verified only in a throwaway container, as `${CLAUDE_PLUGIN_ROOT}/skills/sidequest/references/outside-code.md` says, never on the host.
5. **Prove it for real.** When the proof needs a shared thing from `settings.shared`, land takes it: start no other ticket that uses it meanwhile. Make the running thing serve the landed code the way its `refresh` says: nothing for `auto`; the command; for `ask`, one request to the person in the waiting shape with the exact steps. Never stop a process this session did not start: the running app is the person's. Run the story's proof against the landed result: the steps that reproduced the bug, or a walk through the feature the way a person will use it. More than one command: a scout does it, named the brief file `start` kept for a ticket of the story, unless the proof changes shared data: then run it yourself as one script that writes the old values down first and restores them, so the restore has one owner. When nothing can check it for real, the result is `tested, not seen working`. Beside the proof, in the same message, start the blind passes `${CLAUDE_PLUGIN_ROOT}/skills/plan/references/blind-passes.md` names for landing: the whole diff against the story when it has several tickets, and the words that go out against the diff and what was checked.
6. **Record.** For each ticket, `mcp__sidequest__ticket`: a note with the merge commit sha, the verify result (`pass`, `fail` or `not measured`) and what the proof showed, then status `done`. Only once its merge is on the landing branch and verify passed, from the main checkout run `node "${CLAUDE_PLUGIN_ROOT}/scripts/worktrees.mjs" --remove-safe --branch=<run branch>`, one `--branch=` per ticket you landed, because other sessions' and people's worktrees are not land's. A worktree on a branch goes while the branch stays: a branch goes only when another branch or a remote holds its commits, so a landing branch that is not merged or pushed yet is kept. When it keeps a worktree only for ignored files a check run wrote there (a log, a cache), delete those files and run it again; any other ignored file is the person's. Never a plain `git worktree remove`: on Windows it deletes the main checkout's files behind a link.
7. **Deliver.** With a remote: push the integration branch and open a PR that says what changed, behaviour by behaviour, the decisions behind it and the verify result. Patch each of those tickets with `pullRequest` set to the PR's address, so the board can tell when it comes back. When the story's decisions hold the address of a step done before building, link it in the PR text. When others commit here too (`git shortlog -sne <default branch>` shows more than one author), stop at the open PR, or without a remote at the landed branch, and say in one line that merging is theirs, unless a ticket's delivery rule or the project's own instructions say to merge. When only this person commits, merge it once it is green and not a draft, unless a merge deploys: then it is theirs too. Without a remote that merge goes into the branch the work started from; record that sha. Then run step 6's command again, adding `--worktree=<folder>` for step 2's worktree when you made one.

When the story has a path and `routing` shows `pullRequestDiagram` as yes or not asked yet, read `references/pull-request-diagram.md` before writing the PR text.

A ticket whose start log line carries a delivery rule lands the way it says; the one verify still runs on the result.

**When a commit, a push or a pull request waits on their yes** (the project's rule, or words that go out under their name), they are asked to put their name on code they have not seen, so the review's wait is their reading time. Write it once, on the ticket's `forYou.sayingYesTo`, in two steps:

1. Once the proof has run: `changed` (a line per area, and the one command that shows the whole diff), `checked` so far, the `hunks` that carry the design.
2. When the review is back: `reviewFound` (a fail says what changes in what they read) and the words that go out (`commitMessage`, `pullRequestTitle`, `pullRequestDescription`), with the ticket `needs-you`, the question one short line starting with the verb (`Commit, push and open the pull request?`), what you did not act on (a review note) as `alsoYours`.

Each time, say in the chat what the reply hands you. A clean checkout of theirs gets the change on the ticket's branch before the question, with the ticket's `branch` patched to it and the command back to where they were. One holding other work is left alone: give the folder.

Send the words stored on the ticket (its `ticket` view), never retyped: what they read is what goes out. The closing view names any you change after their yes.

A board whose folder is not a git repository has its work in the repository each ticket's result names. Run every git command, and `scripts/worktrees.mjs` for the removal, in that repository, never in the board's folder. A ticket whose result names no repository has nothing to merge: run the checks, prove it, record it.

A story delivered in checkpoints keeps one integration branch, and with a remote one PR that stays a draft until the last checkpoint. At a checkpoint, start the result in the background and say where to look, or show the output.

## Rules

1. **Verify the composed tree, not the parts.** Branches that were each green can be red together.
2. **Read the real exit code.** Run the verify unpiped: a pipe into `tail` reports its own exit code.
3. **Zero tests run is a failure.** A filter that matches nothing exits green. Check the output says tests ran.
4. **Rebuild generated output from source.** If the project builds artifacts, build them before verifying.
5. **Git is the record.** A ticket is landed when its commit is on the landing branch, checked with `git log`, never because a tool said ok.
6. **Never `git reset --hard` a branch that can hold unpushed merges.**
7. **CI on the pushed commit is the final word.** Read it after every push.

## When something goes wrong

On a merge conflict, a red verify or a red CI: stop merging. Say what you observed and the one next move, then take it if it is yours:

- a conflict between two tickets: file a `debug` ticket that resolves it, blocked by nothing, and run it;
- a red verify or red CI: first check the base without the tickets (the same verify, or its CI). A red base is said in one line and sends no ticket back; only a failure the base lacks counts. Otherwise find which merge turned it red (bisect over the merges, only now that it is red), note `verify fail: <what failed>` or `ci fail: <what failed>` on that ticket, and land the rest without it. Its first failure sends it back to `ready`. Its second of any kind (`review fail:`, `verify fail:`, `ci fail:` on its log) stops it: fix it yourself when what is left is small and clear, else `needs-you` once with both findings, as the `run` skill says. No third run;
- a decision only the human can make: move the ticket to `needs-you` with the question and your recommended answer.

When `settings.verify` is empty, look for the project's own test command (package scripts, a Makefile, the CI config) and say which you used. Pick one that covers every language the tickets changed, and read what it runs: a wrapper that ignores errors (a make line starting with `-`, `|| true`) exits 0 on a red suite, so call what it wraps. When the full suite is slow or needs services you cannot start, run the tests for the changed areas and record the full suite as CI's. None at all: record `not measured`, never `pass`.

If the sidequest tools are missing, the mod is not loaded. Say so and record the sha and verify result in each ticket file's `## Log` yourself.
