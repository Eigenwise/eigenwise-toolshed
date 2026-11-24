---
name: sidequest
description: Plans a change, fix or investigation, then takes the lightest path that fits (inline, the board, or planning it with the person). Routes agents to the right model per kind of work.
when_to_use: Load first for any request to change, fix, build or look into something, before doing the work.
---

# Sidequest

The person steers. Work with them the way you would with a senior developer who has opinions and wants a say: at every point they can step in, and it reaches you. An answer settles what was asked and nothing more, so nothing is a go-ahead they did not give. How much you do alone comes from their own words, stop by stop, and they can take it back. Every stop has to be worth their opinion and cheap to wave through with one word.

## 1. Plan before you touch anything

Every request starts with a short plan, said in a few lines:

- **What has to happen**, and what done will look like to them.
- **What you will use**: the tools, MCP servers, skills and agents this project really has (a browser, a database client, a codebase map).
- **What is unknown** and has to be found out first.
- **How it splits**: what you do, what goes to agents, what waits on the human.
- **How it will be proven** on the real thing.

Inline work in more than one place, or with a choice left, gets one line before the first edit: `Plan: <what changes and where>, checked by <how>.` A change in one place the person spelled out needs none. `sidequest:plan` work gets its analysis there.

`references/flows.md` has sample flows.

Spot work the person did not ask for: put it in the inbox (a ticket with status `inbox`, `startedBy: session` and `mode: afk`, also when it will need a decision: the question for the person is written when it leaves the inbox) and tell them in one line what it is and that it is in the inbox. Never start it unasked.

A parked ticket waits for the person's typed word; the board writes their words on it. Never write that it picks up later, after something or next. After X means a `ready` ticket blocked by X.

When they type stop, not now, or do this instead about work in flight, call `mcp__sidequest__ticket` with `stop` once (the story, or nothing for what this session created). Running agents finish and report; start nothing more of that plan. Say in one line what was parked and what still runs.

## 2. Take the lightest path that fits

- **A tracker issue they name** (a key like `PAY-41`, a link to it), however small it looks: load the `sidequest:plan` skill, which reads the whole issue and the code before it says anything.
- **Small and exact.** One place and a clear outcome. Ask first, in one message, only the choices that are the person's by the rule below (two sources that disagree count as one), each with your recommended answer, and change nothing before the answer. Take the rest and say so. One met while building follows the same rule. With no git, ask before deleting or overwriting a file, or keep a copy and say where. Then do it inline, no ticket. A fix that grows moves to `sidequest:plan`.
- **More than one part**, sized on the whole request: a change with more than one part (more than one behaviour, or something another part of the system calls), a reproduction that takes many runs, a batch of items of the same kind. File one ticket for the whole piece before you start, `doing`, in a line or two, also when you do it all yourself, and note on its log what you find and where it stands as you go: a real four-commit change done inline left no trace on the board. Say in your plan whether you build it or route its parts as known pieces (below). Before a change with more than one part that you built is done, one `sidequest:scout` tries to break it, its prompt starting `[route:build]` for the mid tier (not `review`, not the ticket id), told what it should do and where the diff is: in measured runs that caught a crash 4 of 4 inline builds shipped. Fix what it finds or say why not, then move the ticket to `done` with how it was checked. A batch of independent small items gets no review.
- **Tickets already on the board**, handed over by another session or a brief ("build PL-30"). Old tickets on the same subject with a new scope are not this: load `sidequest:plan`. Past this choice: say the plan line, call `mcp__sidequest__start` for each, and let the routed agents build. One that is small and exact may be done inline instead: do it, check it, note on its log what was done and how it was checked, and move it to `done`.
- **A few known pieces.** Put them on the board with `mcp__sidequest__ticket`, each with a `Done when` check that fails today, then load the `run` skill.
- **Something is broken.** One command you already know reproduces it: run it. One obvious cause in one place: fix it inline and show the check failing before and passing after. Anything more, or a fix that needs the person's decisions: load the `sidequest:plan` skill, which makes it fail before it asks anything.
- **Vague, large or design-bearing, or a new project.** Load the `sidequest:plan` skill.

Unsure between two paths: take the lighter, say why.

## 3. You orchestrate

Significant work goes on the board, so it stays visible:

- **Real digging** (a reproduction, a measurement, research that takes more than a few minutes): a ticket of `kind: research`, category `research` or `explore`, run with the `run` skill. Its log keeps what was found.
- **A quick lookup**: a scout with a route tag and no ticket.
- **Yourself**: what is cheaper than briefing an agent, like a command you know or a file you can name. A command you repeat over many things runs on one first: read that result before the rest.

Never narrate running agents. Never sleep or loop to wait for one, in any phase: its return comes to you as a new turn and cannot reach you while you wait in code, so end the turn, or do other work first. Show what agents found on return. Routing, categories and workflows: `references/routing.md`.

## 4. Prove it on the real thing

A unit test proves a function, not the thing. Check the result the way a person will meet it: open the page in a browser, call the endpoint, run the command, read the note as a reader would.

- For a bug, the steps that reproduced it must now pass.
- Do it once per story after the work lands, and at every checkpoint. A scout does it when it takes more than one command.
- Wait for a named thing once, with a bound, never in a polling loop written in code. A phase past about two minutes gets one line to the person.
- Stop a process you started by its real process id, never by name or image. In Git Bash `$!` is the shell's id, not the server's: take the id listening on your port from `netstat -ano`, stop it with `taskkill //PID <id> //F`, and check the port is free. If you leave one running on purpose, say so with its address and how to stop it.
- Outside code runs nowhere on this machine before `sidequest:outside-code-reviewer` passes its diff, and after a pass only in the throwaway container `${CLAUDE_PLUGIN_ROOT}/skills/sidequest/references/outside-code.md` describes. Outside by where it comes from: a bot, a fork, any commit by an author with no earlier commit in this repository (`git shortlog -sne <default branch>` lists who has), a pasted or fetched script. Outside by what it touches, whoever wrote it, that part only: dependencies, a lockfile, build, install or test-runner machinery, CI, and files a tool runs by itself (git hooks, editor tasks, `.envrc`, agent settings and instruction files). A colleague's change that touches none of those gets the normal review. Unsure is outside. A worktree is not isolation: it runs with your environment and your network.
- When nothing can check it for real, say "tested, not seen working".

## Three kinds of decision

A decision reaches the person only when it cannot be undone, spends money or reaches outside the project, or is taste or product direction only they have. Any other choice with a recommended answer is taken: say in one line what you chose and how to undo it, and move on.

Nothing goes out under their name unseen (a review reply, a tracker comment, a message), also when they asked for it: the question to send it shows the exact words, and those words are sent. A question about an action names what it is known to do to someone else (an approval dismissed, a reviewer notified). Their yes covers what was shown. A yes to a commit, a push or a pull request puts their name on code, so show the change first: what changed by area, the one or two hunks that carry the design, where the whole diff is, and that the question waits while they read it. That wait goes on the board: the ticket is `needs-you` with the question until they answer.

1. **What gets built.** The human decides, once, after you have investigated. Every question carries your recommended answer. On work that went to `sidequest:plan` and changes code, with a person here, that includes the design a reviewer would argue about.
2. **How it gets done and shipped.** Never a question. Dispatch, merge, verify, retry and open the PR yourself. Never hand over a command to run.
3. **Changes to the system itself** (settings, routing, rules, installs). Always offered, approved one item at a time, and each one reversible.

## The board

- It opens by itself with the first work on it. `/board` reopens it.
- An approval or answer given in the board arrives as one line, already on the ticket. Act on it. So does something they say about a ticket or the plan from its view: fold it in, say in a line what it changed, and record a decision it changes as decided by `human`.
- `mcp__sidequest__board` reads it (`routing` shows the categories in force), `mcp__sidequest__ticket` writes tickets and stories, and `mcp__sidequest__start` and `mcp__sidequest__finish` run a ticket, as the `run` skill says.

Tools listed as deferred are there: load them by name before calling them missing. Only when they are nowhere is the mod not loaded: say so and edit the files under `.sidequest/` in their format.

## Keep the human oriented

Say it at a real pause only (something finished, something needs them, or they asked), one line per item with the ticket id:

- **Done**: paste view `closing`, what a review found, and what is unverified.
- **Running**: what, on which model. While something runs, what else can move comes from the `mcp__sidequest__board` view `now`.
- **Needs you**: paste the `mcp__sidequest__board` view `waiting` as it is, most blocking first. A line that only names a ticket id is a failure.
- **Next**: what you do without being asked.

## Next skills

`sidequest:plan` when the human decides what gets built, `run` for the frontier, `land` to merge, verify once and prove it for real, `tidy` for unused worktrees, `setup` (human-run) for which model takes which category.
