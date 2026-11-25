---
title: Words used here
description: The words these pages use, each in one or two plain sentences.
---

Every page explains a word the first time it uses it. This page has them all in one place.

## Claude Code words

| Word | Meaning |
| --- | --- |
| **Session** | One conversation with Claude Code in a project folder. |
| **Plugin** | A package that adds skills, tools, agents or screens to Claude Code. |
| **Marketplace** | A list of plugins you can install from. The Toolshed's is called `eigenwise-toolshed`. The older Toolshed used the same name, so a plugin update moves you to this version. |
| **Skill** | A page of instructions Claude loads when the work calls for it. You can also start one yourself by typing its name after a slash, like `/sidequest:run`. |
| **Tool** | Something Claude can call to read or change things, like reading a file or writing a ticket. |
| **Agent** | A helper session the main session starts for one piece of work. It reports back when it is done. Also called a subagent. |
| **Main session** | The session you are typing in, as opposed to the agents it starts. |
| **Mod** | A plugin part that runs inside Claude Code. It can draw a pane and react to events without starting a process. |
| **Pane** | A panel beside the chat. The board is a pane. |
| **Band** | One line above the message box. It counts what needs you and what is ready, names the running agents and their models, and has an `open board` button. |
| **Rule** | A markdown file in `.claude/rules/` that Claude Code loads by itself. With a `paths` list it loads only when Claude touches a matching file. |
| **Worktree** | A second working folder of the same git repository, on its own branch. Agents work in one so they don't disturb your files. |
| **Scope** | Where a plugin is switched on. `user` is you in every project, `project` is everyone who clones the repository, `local` is you in this one project. |

## Toolshed words

| Word | Meaning |
| --- | --- |
| **Board** | The list of work in a project. It lives in `.sidequest/` as plain files. It is personal and stays out of git. |
| **Ticket** | One piece of work on the board. One markdown file, with an id like `PL-12`. |
| **Id prefix** | The letters ticket ids start with, like `PL`. A board takes them from the project's folder name (`photo-library` gives `PL`), says which it picked, and keeps them in `.sidequest/board.json`, where you can change them while the board is young. |
| **Story** | A group of tickets with one goal. It records the destination, the decisions and what is left out. |
| **Piece of work** | A story, or tickets that share a tracker key like `PAY-41`. With more than one in flight, the board groups by it. |
| **Frontier** | The tickets an agent can start right now: ready, not waiting on you, and with nothing left blocking them. |
| **Plan** | What a vague or large request, or a tracker issue you name, goes through before anything is built. Claude reads, puts what it found on the board with what is yours to decide, and shows the proposed tickets for one yes. The skill is `sidequest:plan`. |
| **Analysis** | The long form of what Claude found: code excerpts, a small diagram of the path the change takes, and each option. It is in the board pane under The plan. |
| **Routing** | Picking the model for a piece of work from its category. |
| **Route** | The model and effort one piece of work runs on. |
| **Category** | A kind of work, like `explore`, `build` or `review`. |
| **Tier** | A model plus an effort level. Each category points at one tier. |
| **Scout** | An agent that only reads. |
| **Worker** | An agent that changes files and commits on its own branch. |
| **Checkpoint** | A planned stop where you look at a finished slice before the next one starts. |
| **Evidence** | What Quartermaster noticed while you worked: counts of commands, failures and denials. Never your prompts or code. |
| **Candidate** | Something Quartermaster noticed often enough to name, like a command you typed by hand 14 times. |
| **Proposal** | One suggested change to your setup, with the reason, the exact change and how to undo it. |
| **Map** | A short description of your code, split into one card per area. |
| **Card** | One file of the map. It loads when Claude works in that area. |
| **Stale** | A card is stale when the code under it changed after the card was last checked. |
