# Routing, categories and workflows

## Routing works without a ticket

Any `Agent` spawn whose prompt or description carries a route tag runs on that category's model and effort from `.sidequest/board.json`. Put the tag at the start, where it's easy to read:

```
Agent({
  subagent_type: "sidequest:scout",
  description: "Find how uploads retry",
  prompt: "[route:explore] Find where failed uploads are retried and what decides the delay. ..."
})
```

A spawn whose prompt starts with a ticket ref routes on that ticket's category. The ref is in the board's own prefix, as the board gives its ids out (`PL-12` here, `SQ-12` on a board from before prefixes); a tracker key or another board's id there routes nothing. A ref further into the prompt routes nothing. A spawn with no tag and no model (a workflow agent with no agent type, `general-purpose`, a Sidequest role) runs on the `settings.unrouted` category, `build` by default, so tag read-only fan-out `[route:explore]` to keep it cheap. Naming a model in the call always wins.

Only these types get a routed model and effort: the built-in `general-purpose`, `Explore` and `Plan`, a workflow agent or teammate with no type (`workflow-subagent`, `teammate`), and `sidequest:*`. Any other type, a user agent that reuses a built-in name included, keeps whatever its own definition names; its run is still recorded with `requested none`.

When a tier names a model nobody provides, the spawn runs on the tier's `fallback`, else the first provider file's `fallback`, else `sonnet`. The ticket log says why, and a spawn with no ticket gets a toast naming the fallback and the reason.

With `CLAUDE_CODE_EFFORT_LEVEL` set, that variable takes precedence over both a definition's and a call's effort, so routing sets no effort at all, for Agent calls and workflow agents alike.

## Categories

Default categories: `explore` and `research` (scout), `quick`, `build`, `hard` and `debug` (worker), `review` (scout), `outside-code` (outside-code-reviewer). `build` is the default for ordinary work. Use `sidequest:scout` for anything read-only and `sidequest:worker` for anything that changes files.

`outside-code` is for outside code, before any of it runs: outside by where it comes from (a bot, a fork, any commit by an author with no earlier commit in the repository, a pasted or fetched script) or by what it touches, whoever wrote it, that part only (dependencies, a lockfile, build, install or test-runner machinery such as a Makefile, a Dockerfile, package scripts, `conftest.py` or a submodule, CI, and files a tool runs by itself: git hooks, `.gitattributes` filters, editor tasks, `.envrc`, agent settings and instruction files). A colleague's change that touches none of those is `review`. For the author, give the ref: `git shortlog -sne <default branch>`; with no ref it reads standard input and prints nothing. A bot is outside however many commits it has. A shallow clone, a missing default branch or an empty list is unsure, which is outside. An earlier commit decides who gets the pass, never whether a line is safe. Write the diff to a file and name it in the ticket: the reviewer has no shell. What happens after its `pass` is in `outside-code.md` beside this file.

`mcp__sidequest__board` with view `routing` shows what is in force for this project.

## A second reader for work you built yourself

Before a change with more than one part that you built is called done, one scout reads it and tries to break it:

```
Agent({
  subagent_type: "sidequest:scout",
  description: "Second look at PL-12",
  prompt: "[route:build] Review the change for PL-12, uncommitted in the main checkout (git diff). It should <what the ticket says>. Run it, feed it what a caller could send, and try to break it. Read-only."
})
```

`build` runs it on the standard tier (sonnet, medium) on every board, one an older version wrote out in full included. `review` is the deep tier: measured, a mid-tier reader caught the same crash, and `review` made a batch 8 times dearer. Keep the ticket id out of the start of the prompt: on a `build` ticket the board would take the reader's return for the work's own and move the ticket. Note its verdict on the ticket yourself, fix what it finds or say why not.

## Workflows go through tickets

A workflow is a way to execute tickets. Before you write or run one for work the human agreed to, the tickets exist: one per outcome, never one per agent or stage. Start every agent prompt with the ticket ref, and add a stage tag where a stage needs another route: `PL-12 [route:review]`. The tag picks the model for that stage and the ticket gets the run on its log. Name no model in the script. Agents never create tickets and never touch the board; this session writes the results back.

A read-only sweep with nothing to track needs no ticket. Tag each agent `[route:explore]` or `[route:research]`.
