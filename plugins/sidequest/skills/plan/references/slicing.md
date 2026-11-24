# Slicing a story into tickets

A ticket is one outcome the human would recognise from the conversation and can check when it is done. Too high is a story ("rebuild the board"). Too low is execution: how a ticket gets built, reviewed and fixed is runs on its log, never more tickets.

Cut **tracer bullets**: vertical slices, each a thin but complete path through every layer it needs, each demoable on its own, each small enough for one fresh agent. Prefactoring goes first.

Every story names its **proof**: how the finished result gets checked on the real thing, the way a person will meet it. For a bug it is the steps that reproduced it. For a feature it is a walk through it from start to end. Write it in the story's destination, so `land` runs it once the work is in. A ticket whose only honest check is a small version of that proof (a prompt, a setting only the running thing shows) says so in its `Done when` and lists what it needs under `uses`; the story's proof stays larger than the ticket's check.

Work that comes from an issue tracker carries the issue key at the start of the story title and every ticket title, so the board and the branch name carry it. Whether commit subjects and the pull request title carry it is the repository's own style: read `git log` before a delivery rule says so.

For every ticket:

- `title`, and a `What` in behaviour from the user's side, then the approach the human agreed to, as the playback showed it: the signatures or shapes that change, the files or areas, the tests by name. The agent that builds it sees only this ticket and its story's destination and decisions. Never line numbers: they go stale before the ticket runs.
- `uses`: only when the whole run needs something that exists once (a reproduction against the running app, a migration, a load test), the names from `settings.shared`. A build ticket usually has none: it edits in its worktree and is proven after landing, so building runs in parallel and only the proof takes turns.
- `blockedBy`: only the tickets that truly gate it.
- `kind`: `build`, `decision`, `research` or `review`.
- `mode`: `afk` when an agent can finish it alone, `hitl` when it needs the human (a judgement, an account, a look and feel).
- `category`: the routing category, `build` unless there is a reason.
- `decisions`: the `D-n` ids it implements.
- `Done when`: a check that fails today and passes when the ticket is done, worded so a person can judge it: what the thing does for which input. A line the person worded starts `In the person's words:` and is never loosened.

## Checks and shared things

Read `settings.checks` first (`mcp__sidequest__board` view `routing`). A ticket whose `Done when` runs in a shared thing lists it under `uses`. When it says `not written down` and the checks need something a worktree lacks, say so in the plan and offer `settings.worktrees` false there, not after workers fail. A worktree you add by hand to find that out goes with `node "${CLAUDE_PLUGIN_ROOT}/scripts/worktrees.mjs" --remove-safe --worktree=<folder>`, never a plain `git worktree remove`: on Windows that deletes the main checkout's files behind a link.

## How it gets delivered

Asked once per story, in the last grill round; when an earlier story file recorded an answer, recommend that one. Record the answer as a decision.

- **In checkpoints**: thin slices they look at as each one lands. Propose the slices that fit this work, for example the screens and the flow on dummy data first, the real logic once they approve that.
- **All at once**: build the whole thing, they look at the finished result.
- **Their own way**: whatever rhythm they describe.

## Checkpoints

When the human chose delivery in checkpoints, each checkpoint is a ticket of its own: `kind: review`, `mode: hitl`, titled for what they will look at ("Look at the upload flow on dummy data"). It is blocked by the tickets of its slice, and the first tickets of the next slice are blocked by it. So the work stops there by itself, and nothing after it starts until they have looked.

Its `What` says what they will see and how to see it. Its `Done when` is their yes.

Slice so that what comes before a checkpoint is worth looking at alone. For work with a face, that is usually the screens and the whole flow on dummy data, then the real logic behind it. For work with no face, it is the first path that runs end to end on one real input.

## A new project

An empty project has no code to read: scouts research how this kind of thing is usually built and which stacks are realistic for it. Its first ticket is a **walking skeleton**: the thinnest thing that builds, starts and passes one real check from end to end, in the stack the human chose. No features. Its `Done when` is that check. Everything else is blocked by it.

- If the repository has no commit yet, commit what exists first (`git commit --allow-empty` when nothing does), so agents have a commit to branch from. A folder that only became a repository in this session cannot run worktree agents until the session restarts.
- Say in the playback that the skeleton's check becomes the board's verify command. Once it passes, write it into `settings.verify` in `.sidequest/board.json` yourself: the plan's yes covers it.

## Play them back

In the playback each proposed ticket is one short block, numbered: its title, what it waits for, its approach as the ticket will carry it (the signatures or shapes that change, written as code where that is shorter than words, the files or areas, the tests by name), and its `Done when` as a check a person can read and judge (`the import keeps a row whose number matches but whose name is new`, never `tests pass`). A person who writes code reads this block the way they read a pull request description, so a plan in general words is no plan to them. Five fit one screen. The person can retitle, drop, add or reword in a few words, and "go" takes the list as shown. Their wording of a check wins over yours: file it exactly as they said it, the line starting `In the person's words:`, with nothing of yours added to it.

After the blocks, one short block says who does what, in the project's words: what runs at the same time, what waits for what and why, which check runs beside which build, and on which tier. Where a shared thing forces turns (one checkout a test stack serves), one line says so.

```
1 and 2 run together on the fast tier; 3 waits for 1 (it reads the new field).
Each build is reviewed while the next one runs. The app serves one checkout, so the proof runs once, after all three land.
```
