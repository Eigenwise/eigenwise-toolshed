# Sidequest

A work board for Claude Code that plans the work with you and routes each category of work to its model. Give it a problem: it reads the code first, pushes back where the request looks off, asks only what you must decide, then splits the work across agents, each on the model that fits.

Everything is plain files in your project. The board pane and band only show them.

## First five minutes

```bash
claude plugin marketplace add Eigenwise/eigenwise-toolshed
```

```bash
claude plugin install sidequest@eigenwise-toolshed
```

Then, in a project:

1. Describe something you want done. Sidequest sizes it and names its path. A small exact fix just happens. A vague or bigger ask gets planned with you first (the `plan` skill).
2. `plan` reads first: the whole request (a tracker issue with its comments and attachments, images opened) and the code, or it makes a reported bug fail. It writes what it found once, on the board: with the board pane beside the chat, the pane opens on the plan and the chat says what is asked, what it recommends and that the analysis and the decisions are on the board (/board opens it); with no pane, the chat gets the short version and the decisions. Then it asks what you must decide. On code that includes the design a reviewer would argue about: the interface, where the behaviour lives, what is left out, how it is tested. They come a few at a time, starting with what the rest hangs off, and an answer that opens something gets its follow-up. Each question has a recommended answer, so "yes" takes it and "you decide" ends it. Then the plan comes back as the tickets' own text, technical plan included, for one yes. Those tickets are filed as proposed: nothing starts, counts or lists them as open work until you say yes, and the plan view leads with the first paragraph of where it is going, the answer of each decision taken by default (one row each), any decision still open and **Yes, build it** with a field for a correction (typing in the chat works the same), then the rest of where it is going, each ticket as a block, every decision in full and the long read. With the pane placed the chat only points there; with no pane, the whole playback is in the chat. A stop parks them with the plan.
3. Once you agree to the breakdown, it runs the tickets in parallel and lands them as one PR.
4. `/board` opens the board beside the chat.
5. `/sidequest:setup` if you want different models per category. The defaults route with zero setup.

## The board files

```
.sidequest/
  board.json        id prefix, routing table, categories, settings, id counters
  tickets/PL-12.md  one ticket per file
  stories/PL-S3.md  destination, decisions, out of scope
```

Each board has its own id prefix, so an id said in a conversation that spans two projects points at one ticket. The first ticket or story on a new board picks it from the folder name (`photo-library` gives `PL`), skips any a tracker key in your branch names uses, keeps it as `"prefix"` in `board.json` and says so: change it there while the board is young. Stories add an `S` (`PL-S3`). A board with tickets from before prefixes keeps `SQ-12` and `ST-3`.

`.sidequest/` stays local through `.git/info/exclude`: the board is personal, and a team shares work through its tracker. The first ticket adds that line itself and tells you once. If git already tracks or ignores the folder, nothing is added. The first start on a board that runs agents in worktrees adds `.claude/worktrees/` the same way, unless that file or the root `.gitignore` already lists it, so a `git add -A` never stages an agent's checkout. If the folder is not inside a git repository at all, the first ticket's answer says where the board was created and that the folder is not a git repository, once, and nothing is refused. `node scripts/boards.mjs [folders]` here lists the boards on this machine (installed project folders, folders sessions ran in, and yours) with counts, last change (from the tickets' own stamps) and whether each is in a git repository. It marks stale strays and removes nothing unless you add `--remove=<project folder>`, which deletes only that folder's `.sidequest/`. All worktrees of a bare repository share one board in its git folder. Tickets are markdown with flat frontmatter (`status`, `kind`, `mode`, `category`, `branch`, `issue`, `startedBy`, `blockedBy`, `decisions`, `uses`), a `What`, a `Done when` and a `Log`. You can edit any of it by hand, lists as `- value` lines too. A file whose frontmatter never closes is named as damaged and left alone. Only `<id>.md` is the ticket: a sync tool's copy is named as a stray and never written, an edit made while a write runs is kept, and when two sessions file at once the one that lost the name sees it and takes the next id.

A new ticket takes the checked-out branch and a tracker key (`PAY-41`) from its title or branch, never one in the board's own prefix. The board names a ticket by its key first and the id after (`PAY-41 PL-2 (branch PAY-41-retry)`), flags a checkout on another branch, and marks work the session started unasked. When the waiting, now and closing views show more than one piece of work (a story, or tickets sharing a key), they group by it: one heading per piece with its key and the story's title, the work this session is on first, and each ticket under it as its title with the id in brackets. One piece of work reads as it always did.

A ticket also knows its pull request. With a remote, the waiting view asks `gh` where each one stands and brings back done work that got changes requested, and `start` says when someone else is already on the same key. No remote, no `gh` or a slow answer, and nothing changes.

A ticket's `mode` is `afk` (an agent can finish it alone) or `hitl` (it needs you, so it is never dispatched). One that waits on you carries a `## For you` section you can answer cold: the question (one short line starting with the verb), why now, each option with what it gets and costs, the recommendation, and what happens if you never answer. The block the session shows you in the chat leaves out why now and what silence does, since the chat above it says that. A question that waits alone has no number: answer with a letter, plus the numbers of any extras (`A, plus 1 and 3`); with several, each is numbered and its extras carry its number (`2A, plus 2.1`). The **frontier** is every `ready`, `afk` ticket whose blockers are all `done`.

## Things that exist once

A stack, database or port only one run can use goes in `settings.shared`: `"stack": { "what": "the local app", "refresh": "auto" }` (`refresh`: `auto`, `ask` or a command). A ticket lists what it holds in `uses`. While a `doing` ticket holds one, tickets that need it wait behind it (`alongside: true` starts one anyway) and briefs say who may touch it. With `settings.worktrees` false, worker tickets hold the `checkout`.

## Routing

Run the main session on a mid-size model or better: on the cheapest one about 2 in 7 feature requests with several decisions were built before any question was asked (measured 2026-11-18). Routed agents can be cheaper.

Each category maps to a tier, and each tier to a model and an effort:

| Category | Role | Tier | Default model / effort |
| --- | --- | --- | --- |
| explore | scout | light | sonnet / low |
| research | scout | deep | opus / high |
| quick | worker | light | sonnet / low |
| build | worker | standard | sonnet / medium |
| hard | worker | deep | opus / high |
| debug | worker | deep | opus / high |
| review | scout | deep | opus / high |
| outside-code | outside-code-reviewer | deep | opus / high |

The `top` tier (fable / high) is there for categories you point at it.

A spawn is routed when its prompt starts with a ticket ref in the board's prefix (`PL-12`) or carries a route tag, with or without a board:

```
[route:explore] Find where failed uploads are retried and what decides the delay.
```

A spawn with no tag and no model (an untyped workflow agent, `general-purpose`, a Sidequest role) runs on `build` instead of your session model, and Claude is told on the next prompt. Set `settings.unrouted` in `board.json` to another category, or `inherit` to switch this off.

Only the built-in `general-purpose`, `Explore` and `Plan`, untyped workflow agents and teammates, and Sidequest's roles get a routed model. Other agent types keep their own, recorded on the run. A spawn that names a model, and forks, are left alone. Details: `skills/sidequest/references/routing.md`.

`sidequest:worker` writes code and commits on its own branch, and the session brings the commits where the brief's delivery rule says. `sidequest:scout` is read-only. Neither names a model. Routing picks among Claude models, plus any model a provider file under the Claude config folder lists; nothing in this version writes such a file.

### Code from outside

`sidequest:outside-code-reviewer` has Read, Grep and Glob and nothing else, so text in a pull request can't get it to run anything. Outside is where a change comes from or what it touches. Where from: a bot, a fork, an author with no earlier commit in the repository, a script you pasted or the session fetched to run. What it touches, whoever wrote it, you included: dependencies, a lockfile, build, install or test-runner machinery, CI, and files a tool runs by itself (git hooks, editor tasks, agent settings and instruction files), and then only that part, before anything is installed. A colleague's change that touches none of those gets the normal review: giving every teammate's branch the security pass cost four to five dollars per eight branches in a measured triage. When the session can't tell, it counts as outside and says so. The reviewer reads the whole diff and answers `pass` or `hold`. Hold runs nothing and waits for you. Pass runs the check in a throwaway container with no network and no credentials, and land verifies such a branch there too. With no container runtime it says `not run: no container runtime here`. Your own code pays nothing per ticket. Added after outside pull requests were reviewed for real on 2026-11-19: the review route as it stood would have run them on your machine.

## The four tools

| Tool | Does |
| --- | --- |
| `mcp__sidequest__board` | Read: summary counts, why nothing can start, the inbox by title and earlier work in words, what waits on you ready to paste (`waiting`), what else can move and what you could do (`now`), the closing report (`closing`), the frontier, a filtered list (past 50 tickets, settled ones are counted, not listed; or the stories, with `of: stories`), one ticket or story in full, or the routing table and settings in force, or everything the start of planning reads in one call (`planning`: the routing view, the stories and every ticket not done or dropped). |
| `mcp__sidequest__ticket` | Write: create or patch tickets and stories in a batch (`forYou` writes the For you section), move status, add a note, drop a ticket. A patch of status or title logs the old value. Parking a ticket on you answers with its block, ready to show you. |
| `mcp__sidequest__start` | Marks a ticket `doing` and returns the exact `Agent` call to make. An optional `delivery` rule goes into the brief and the log. A second start says the ticket was already started. On a board whose folder is not a git repository the call has no `isolation`, the answer says why, and the brief tells the worker to make its own worktree in the repository the ticket names (the answer says to add it to the ticket when the text names none). |
| `mcp__sidequest__finish` | Adds what the session checked to the run's result and moves the ticket to `review`, `done` or `needs-you`, saying so when nothing was checked. |

Only the main session calls them. The board logs each agent's answer when it returns, and without a `finish` makes the same move a turn later. While an agent is back and not recorded, the `summary` opens with a line telling the session to call `finish` for it now, and the `now` view ends with it after `For the session, not to paste:`, where it also says, while an agent still runs, to end the turn: a session asleep in its own wait loop is never handed the return (seen once: eighteen reads over seven minutes for a return already there). A ticket moved by hand stays put. Slips are repaired, never refused.

## The views

- `/board`, top to bottom: **Waits on you** whenever something does (`3 decisions on the plan` while a plan has open questions, which opens the plan at its decisions; `Your yes on the proposed tickets` while the plan's playback waits; each question, how long once a week, the recommended answer beside it; once you Send from the board it leaves this section until the session records your answer or asks again, and the plan's row says `your answers are with the session`), **Now** (each running agent with its model and how long it has run, ticket work before lookups, a View button on the terminal, the session's own work, what just finished, or `Nothing is running.`), **The plan** (a row per story, which opens its plan), **Waiting on you from earlier sessions**, **You could** (while something runs and there is something to do), **Being checked** (built work in review and proof), **Next**, **Done**, **Finished agents** (every agent that returned this session, newest three, the rest behind one `2 more finished` row), a count of parked and not-ready tickets, week-old tickets under one line, and the worktree row last. Empty sections draw nothing. An empty board (no plan, nothing running, nothing waiting) says what shows up there, and the first open explains the sections once.
- With more than one piece of work on the board (two tracker issues in flight, say) the pane lists by piece of work in place of by status: a heading per piece with its tracker key and the story's title, the work this session is on first, and under it each ticket with what it is (`waits on you`, `from an earlier session`, `answered`, `stopped, nothing runs it`, `next`, `done`); built work that is being reviewed and proven sits under its own **Being checked** label after Now. The band names the work that needs you: `2 tickets need you: PAY-41, PAY-57`. One piece of work looks as it always did.
- A story's heading opens its destination and the analysis written for it, so you can read the long form beside the conversation. A story with an analysis gets a row under **The plan** before it has any ticket, its title with `analysis and decisions` beside it, and writing an analysis opens the pane on it. The plan view starts with the short version (what is asked, how it works today, what was found, the options by letter). While decisions are open the **Decisions for you** come next, three lines each, drawn as markdown so code reads as code: the question, `Recommended:` with the answer (one part per line when it has several, code only where the session marked it), and `Otherwise:` with what the other answer costs, then a field for your own words and **Send**, which puts your picks and your words in the chat as one message (Enter in the field never sends: only Send does, here, in a waiting ticket and in the correction under a plan's proposed tickets), then the path, the analysis (its options lettered A, B, C) and the excerpts. With none open the path follows the short version, and the view ends with what was already decided and the field, the same as typing in the chat with the plan named. The path through the code is drawn as boxes of one width with an arrow between each, the steps the change touches marked `(changed)`, and the code as it reads today with line numbers under its file name; the first time a plan gets a path and no board pane is placed, it's placed once in the conversation instead. A change shown before a commit is drawn as a diff in the ticket view. If you say yes when first asked, pull requests here carry the same path as a Mermaid diagram in their description, with the changed steps marked; `settings.pullRequestDiagram` in `.sidequest/board.json` keeps your answer.
- A finished agent stays pressable for the whole session. One that worked on a ticket opens that ticket. A lookup with no ticket opens what it was asked (the first sentence or two), its model, effort and time, and what it reported, plus View while the host still holds its transcript, or one line saying it is no longer available. Kept in session state, never in a file.
- Every ticket view and the plan view have one field to say something about it (a ticket that waits on you keeps its Answer field instead). A ticket that is done or dropped has none: it opens as a record, with no field, no Send and no question shown as open. A ticket that waits on you opens on its question, with why now and the options before the answers. A ticket that still carries a question it no longer waits on (you answered it, or the session took it up or set it aside) draws its What, Done when and what was decided before the field and the buttons. What you type goes to the session as your message, `About SQ-12 (the title), from the board: "..."`, and is logged on the ticket, or under Log on the plan. On a ticket whose agent is running, it goes to that agent instead, so a correction reaches the build while it runs.
- Before a commit, a push or a PR that waits on your yes, the ticket view shows what you are saying yes to, filled in two steps: what changed, how it was checked and the hunks that carry the design (drawn as a diff) once the proof has run, with a line that the review still runs; then what the review found and the words that go out (commit message, PR title and description). Once the review is back the view leads with two or three summary lines, the question, the extras, your words and Send, and the parts follow under `What you are saying yes to`. With the pane placed the chat gets one line at each step. The words that go out are kept on the ticket and sent as stored; any changed after your yes are named in the closing report.
- A ticket that waits on you opens as the question and nothing else: why now, each answer with what it gets and costs, the recommended one, a list of extras the session left to you to tick, a field for your own words, and **Send**, which puts all of it in the chat as your one message and on the ticket. **Show the whole ticket** brings up the rest, with Set aside and Drop saying what happens to the files and the branch. The plan view's decisions work the same way, each with its recommended answer already picked. After Send (or `Yes, build it`) the view shows what you sent in place of the form, with no second Send, and the band and counts stop counting it; that's kept in the ticket or story file, so it survives a reload, and an answer typed in the chat is recorded by the session as before. The time shown is the UTC minute of the press, with UTC after it. A second press on an answer already sent changes nothing, and if your view was behind the file you see what was sent and a toast saying the first answer stands: to change it, say so in the chat. The ticket's own line reads `answered, with the session to act on`, not `waiting on you`. The board summary lists every answered question nobody has acted on, so the next session picks them up, and the list keeps it until the session moves that ticket or asks again: a note on the ticket does not clear it. The ticket's decisions read **Already decided**, each marked `Decided by: you` or `Taken by default`. Each keeps the day it was made (the UTC day), and a decision you took keeps your own words up to 200 characters (two short sentences: an answer and its reason, short enough for one line of a page); a decision taken by default keeps the day and no words. A question decided again is a new line with its own number and day, and the earlier line stays. The picks you press on a plan are stored with the day and the words you typed, in full until the session writes them as decisions. Where a team tracks its board in git, those words go into its commits. A decision with no day, as older boards wrote them, reads with no day.
- A press opens a ticket, buttons move it. A waiting ticket opens on its question with the answer buttons right under it. Done on a checkpoint, an option, or an answer typed on a ticket that waits on you, also reaches the session as one line, so the run carries on.
- A band above the prompt, one line, each part saying what it counts, with what waits on you first and counted the same as in the pane: `2 tickets need you` (of every branch, and tickets you work with yourself once what they wait for is built), `1 plan needs you` (open decisions or a yes), `1 waiting on you from earlier sessions`, `3 tickets ready to start, 1 running, 1 back, result not written up yet`, `2 being checked` (the tickets under Being checked in the pane), the agents and their models (`7 agents running on opus`, or `12 agents running: 9 sonnet, 3 opus`), any agent parked on a permission prompt, and `open board`. Narrow, only `2 need you  7 agents running`.
- A toast and a notification when a run finishes or something needs you.
- Board calls and routed spawns read as plain transcript rows: `board PL-12 started: worker agent on sonnet, medium effort`.
- First prompt of a session, or after a compaction: reminder to load the skill.
- Five or more linked worktrees: a toast once per session and a Tidy row at the bottom of the board.

## The flow

`plan` → tickets on the board → `run` → `land` → done.

- **sidequest** is the front door. It sizes the request and picks inline, straight to the board, or `plan`. A tracker issue you name goes through `plan`, however small. Before an inline edit it says the plan in one line, and nothing is sent under your name before you have seen the exact words. Clear work with more than one part gets one ticket even when the session builds it, and a change gets one second reader on sonnet before it's called done.
- **plan** is step 2 above: read-only scouts investigate, and for a plan of more than one ticket a blind reviewer strikes questions the code leaves one answer for and turns a design choice hidden in the defaults into a question. The plan comes back for one yes. A correction is folded in and asked again.
- **run** starts every frontier ticket on its routed agent in parallel, records each result when the agent returns, and gets each finished ticket an independent review (not a `quick` one), which fails on behaviour or on a clear break of a guideline the repository wrote down (its rules files, a contributing or style page, linter config), and on nothing else. Five or more tickets run as the saved `sidequest:wave` workflow when workflows are on. A failed run goes to `needs-you`, never straight back to `ready`. A ticket's second failure of any kind (review, verify, CI) stops it: the session fixes it or asks you once.
- **land** merges the reviewed branches into one integration branch (one ticket lands on its own), runs your verify command once on the composed tree, records the sha and the result, and opens a PR. Where your project asks for your yes before a commit, a push or a PR, it shows you the change on the board while the review runs, then what the review found, the words that go out and the question, which sits there until you answer. A clean checkout of yours gets the change on its branch first (the ticket then names that branch), with the command back; one holding other work is left alone, and you get the folder and the one command for the diff. Where others commit too, it stops at the PR and the merge is yours; where only you commit, it merges once CI is green. Afterwards it removes only the worktrees of what it landed.
- **setup** (you invoke it) changes the routing table with a preset: balanced, thrifty or max quality.
- **tidy** says which linked worktrees are finished, wherever they live, and removes those. One holding an ignored file the main checkout lacks, like a `.env`, stays, and one whose name a person chose goes only after you saw it. It also sees agent branches with no worktree and, given a folder, worktree folders git forgot.

A team that does something of its own between agreeing work and building it (a written plan, a design note, a breakdown in its tracker) names that step once in `.sidequest/board.json`: `"beforeBuilding": { "label": "plan of action", "how": "<a skill of yours, or a line of instruction>", "readBack": "<optional>" }`. `plan` offers it by that label as a line in the plan it plays back for your yes, beside how the work is proven and where it ends (one word changes a line). It then hands over what was agreed in the story file, does what `how` says with you, and builds nothing until you say go. Nothing that leaves your machine names the board or its ids: commits, branches and pull requests speak of the work in your project's terms.

You decide what gets built, once, after the investigation. How it gets built and shipped is never a question. Changes to Sidequest's own settings are offered and approved one at a time.

## The older board

Where the older board's database exists in the home Claude folder and this project has no `.sidequest/`, the first session in the project says once that the older tickets are not on this board and that `/quartermaster:upgrade` offers to redraft the ones you pick. Later sessions say nothing. When Quartermaster is installed it says it instead.

## Versus the older one

The board is markdown behind 4 tools; before it was SQLite behind 58. Routing is one table.

## Code Mode

Sidequest works with the host's experimental Code Mode, where the model runs its tools from a script. Checked in real terminal sessions on 2.1.328 and 2.1.329: from a script the board tool answers, a routed agent gets its route, and an agent's return starts the turn the board treats as typed by nobody. A hook of the kind Sidequest has, slow or failing, does not refuse a script's call: tried with a throwaway plugin whose hook throws, runs past its time or spins, the call went through each time, with that mode on and off. Nothing here depends on that mode.

## Not built yet

- Board text search, so duplicates are found by reading the list.
- Resuming a crashed wave from a session other than the one that started it.
- Cost per ticket on the board.
