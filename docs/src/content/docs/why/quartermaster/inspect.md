---
title: 'Inspect: is it working?'
description: A read-only health check. For each Toolshed plugin, is it installed, loaded in this session and actually used?
---

<p class="lead">Installed proves nothing. Inspect checks what this session can really see and use, and changes nothing.</p>

## Why it exists

A plugin can be installed and still do nothing. It was installed after the session started. An environment variable quietly overrides the routing. A hook timed out and nobody saw it. From the chat, all of these look the same: things just seem off.

## Start it

```text
/quartermaster:inspect
```

## What it checks

### Each plugin, on three rungs

| Rung | Meaning |
| --- | --- |
| **Installed** | The plugin is in the list and enabled for this project. |
| **Loaded** | This session can see its skills, commands and tools. |
| **Exercised** | The evidence shows its skills were used in this project. |

It only lists this project's plugins. On a machine with many projects the full list has hundreds of rows.

It also reports a **clash**: a plugin of the same name enabled from two marketplaces. Both would load, so it says which one this session really runs.

### Routing killers

Three settings silently defeat model routing. Inspect looks for each in the environment and in the settings files.

| Setting | What it does |
| --- | --- |
| `CLAUDE_CODE_EFFORT_LEVEL` | Every agent runs at one effort level. The routed effort is ignored. |
| `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` | Every agent runs on one model. |
| `availableModels` | A model the routing uses may be blocked. The agent then falls back to another model with only a warning. |

### Hook failures

A hook that was cancelled or timed out is invisible in the chat. Inspect counts them in the newest transcript, by name.

### Stray boards

A board is Sidequest's list of work in a project. With Sidequest installed, inspect lists boards on this machine that look left behind, like one made in a temp folder. It never removes one.

## What you get back

One line per finding. Each line is one observed fact and one next move.

```text
sidequest: installed at project scope, not loaded in this session. Run /reload-plugins.
CLAUDE_CODE_EFFORT_LEVEL=high set in .claude/settings.json env: routed effort is ignored.
  Remove it or accept one effort for every agent.
live-rules: loaded, never exercised in 23 sessions. Worth a retire proposal from /quartermaster:resupply.
```

It ends with what is healthy, in one line.

## What it never does

<div class="never">

- No installs, no settings edits, no restarts.
- It never guesses. When it cannot tell whether a plugin was used, it says "unknown".
- It never fixes what it finds. A fix to your setup goes through [resupply](/why/quartermaster/resupply/), where you approve it.

</div>
