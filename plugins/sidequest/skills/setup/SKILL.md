---
name: setup
description: Set up Sidequest routing for this project. Explores first, offers a preset for which model runs each category of work, then writes .sidequest/board.json.
disable-model-invocation: true
---

# Setup

Write `.sidequest/board.json` for this project. Sidequest already routes with built-in defaults, so this is only for changing them. Ask only what exploration cannot settle.

## 1. Explore

Find out, without asking:

- Does `.sidequest/board.json` exist? If so, keep its `nextTicket`, `nextStory`, any custom categories and any settings or keys you do not recognise.
- The verify command: package scripts, a Makefile, a task runner, the CI config. Pick the one CI runs on every push.
- Is there a git remote, and is `.sidequest/` already committed or excluded?
- Worktree base, only when a remote exists: `git log HEAD --not --remotes --oneline`. Each line is a commit on HEAD that is on no remote.
- Whether a directory symlink works here: in a new folder in the system temp directory, create a target folder, then run `node -e "require('fs').symlinkSync(process.argv[1], process.argv[2], 'dir')" <target folder> <link path>` with a link path in the same folder, then delete the folder. EPERM means it does not. Any other error is unclear, and the setting is not offered either. A junction is no substitute, the host makes none.
- Hints of something that exists once: a compose file, a fixed port in the verify command or a config file, a start or dev script that runs a server, a database file or connection string. Note each.
- The ignored folders at the project root: `git ls-files --others --ignored --exclude-standard --directory` lists candidates. Keep the lines whose only `/` is the last character, then only those `git check-ignore <folder>` prints back.

## 2. Show what you found

State every settled fact in a few lines: verify command (or none found), remote, current board file. Then the default table:

| Tier | Model | Effort | Categories |
| --- | --- | --- | --- |
| light | sonnet | low | explore, quick |
| standard | sonnet | medium | build |
| deep | opus | high | research, hard, debug, review, outside-code |
| top | fable | high | (none by default) |

`scout` categories (explore, research, review) never write files. `worker` categories (quick, build, hard, debug) do. `outside-code` reads only, with no shell.

Tier models are `haiku`, `sonnet`, `opus` or `fable`.

## 3. Ask, in one question round

Use the question tool once, with every option recommended first:

1. **Routing preset.**
   - Balanced (Recommended): the table above.
   - Thrifty: light on haiku/low, deep on opus/high, top on opus/high, the rest as above.
   - Max quality: standard on opus/medium, deep and top on fable/high, the rest as above.
2. **Verify command**, only when exploration found none. Offer the closest candidate, or "none for now".
3. **Worktree settings**, as a change to `.claude/settings.local.json` (unpushed commits belong to one person; the committed `.claude/settings.json` only if the team adopts it):
   - `worktree.baseRef: "head"`, when commits are on no remote. Without it a worker's worktree starts from the remote branch and lacks them. Name them.
   - `worktree.symlinkDirectories` with the dependency folders, only when the symlink test worked. When it failed, say it will not take effect here and a worker's worktree still lacks those folders.

4. **Shared things**, only when exploration found a hint or the person brought it up. A project with no hint is not asked. Ask once: is there anything here only one piece of work can use at a time, such as the running app, a database, a port or a paid service? For each, one plain line of what it is and how it picks up new code: by itself, this restart command, or I restart it. When worktrees would otherwise go off only because of a running service, recommend the opposite: worktrees on, the service named as shared, so editing runs in parallel and only the proof takes turns.

Tell the human "Other" changes a tier, moves a category or adds one (name, tier, scout or worker, one line).

## 4. Write

Write `.sidequest/board.json` in this shape, with the chosen tiers and any edits:

```json
{
  "version": 1,
  "nextTicket": 1,
  "nextStory": 1,
  "tiers": {
    "light":    { "model": "sonnet", "effort": "low" },
    "standard": { "model": "sonnet", "effort": "medium" },
    "deep":     { "model": "opus",   "effort": "high" },
    "top":      { "model": "fable",  "effort": "high" }
  },
  "categories": {
    "explore":  { "tier": "light",    "role": "scout",  "description": "Find and explain how existing code works." },
    "research": { "tier": "deep",     "role": "scout",  "description": "Real digging: a reproduction, a measurement, or research outside the code." },
    "quick":    { "tier": "light",    "role": "worker", "description": "Small change at a known location." },
    "build":    { "tier": "standard", "role": "worker", "description": "Ordinary feature or fix. The default." },
    "hard":     { "tier": "deep",     "role": "worker", "description": "Design-heavy or cross-cutting change." },
    "debug":    { "tier": "deep",     "role": "worker", "description": "Find the root cause of a failure, then fix it." },
    "review":   { "tier": "deep",     "role": "scout",  "description": "Independent review of finished work." },
    "outside-code": { "tier": "deep", "role": "outside-code-reviewer", "description": "Security pass before code runs that comes from outside the team, or touches dependencies, build, install or CI." }
  },
  "settings": { "verify": "", "planReviewPasses": 1, "worktrees": true, "unrouted": "build" }
}
```

- Add `.sidequest/` to `.git/info/exclude` if it is not there yet and git does not track it. (The first ticket does this on its own when nothing here did.) The board is personal; a team shares work through its tracker.
- On a yes to question 4, add `settings.shared`: an object of name to `{ "what": "one plain line", "refresh": "auto" | "ask" | "<restart command>" }`, for example `"app": { "what": "the running app on port 3000", "refresh": "ask" }`. A refresh that takes several commands is one line joined with `&&`; name in `what` everything the thing is made of (a dev server, a worker, a generated file), so a start can say what is down. Only on a yes; no answer, no `shared` key.
- Keep `planReviewPasses` at 1 and `worktrees` at true unless exploration found a reason (say it), for example tests that need ignored files a fresh worktree lacks. A running service alone is no reason: name it as shared.
- `settings.checks` is a few lines of free text: what the checks need (an ignored file, a shared database), where they can run (the main checkout only, or a worktree too) and the command that works. Write it when the person says it in the verify or shared round or exploration shows it. No extra question. Every brief carries it.
- `settings.beforeBuilding` names a step the project does between agreeing work and building it: `{ "label": "<the team's word for it>", "how": "<a skill of the project, or a line of instruction>", "readBack": "<optional: how to read the result back>" }`. Write it only when the person says the project has such a step. Never a question.
- `unrouted` is the category an untagged workflow, `general-purpose` or Sidequest agent runs on. Keep `build`. `inherit` lets those agents run on the session model.

Worktree settings go in the chosen settings file only after a yes, merged into what is there. To undo, put back what was there, which may be a value, not only an absent key.

## 5. Confirm

One short block: the file written, the preset, any edits, where the board lives. Mention `/board` and that rerunning `/sidequest:setup` changes any of it. Deleting `.sidequest/board.json` undoes the routing. Never say a worktree has its dependency folders unless the symlink test worked and the setting was written.
