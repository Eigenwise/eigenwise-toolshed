---
name: setup
description: >-
  Set up a Claude Code workspace for a new or existing project, informed by hindsight from the
  user's whole session history. Installs and wires whichever Toolshed pieces the project actually
  wants (codebase-mapper, live-rules, sidequest's routing and executors, observability,
  model-gateway are each independent and opt-in) plus stack plugins, seeds rules and permissions
  from what the history shows the user actually needs. Use for workspace setup, .claude
  configuration, project bootstrap, or Toolshed installation.
---

# Quartermaster setup

Outfit a project's `.claude/` workspace end to end. You are an orchestrator: the pieces already
exist (codebase-mapper's `map-codebase`, live-rules' `add-rule`, sidequest, observability's
`enable-project-telemetry`, model-gateway, the built-in `/init`). Your job is to ground the plan
in the user's actual history, interview briefly, install in the right order around the plugin
reload boundary, and verify the result really works.

What makes this different from a checklist bootstrap: recommendations come from evidence. The
miner shows which plugins the user leans on across projects, which permission denials repeat,
and which corrections they keep giving. A new project starts where the others left off.

## Process

### 1. Assess the project

Read the obvious markers in the project root (package.json, pyproject.toml, Cargo.toml, go.mod,
existing CLAUDE.md, existing `.claude/`). Establish:

- **New vs existing**: real source files vs empty scaffold.
- **Codebase vs not**: a wiki or notes vault skips the codebase map but may still want
  live-rules and sidequest.
- **What is already there**: an existing `.claude/` means augmenting, never clobbering. Read it
  first, merge, and say what you will add and what you will leave alone.
- **Git**: if not a repo, ask once whether to `git init` (recommended: it preserves the setup);
  respect a no.

### 2. Mine the user's history

```
node "${CLAUDE_PLUGIN_ROOT}/bin/quartermaster.js" mine --all-projects --days 45 --sessions 60
```

This is the cross-project view: attribution shows which plugins and MCP servers the user
actually uses; denial patterns show which permissions to pre-allow; correction themes show which
rules to seed. Also run `node "${CLAUDE_PLUGIN_ROOT}/bin/quartermaster.js" catalog --installed`
to see what user-scope plugins already apply here.

### 3. Interview, briefly

Ask what the project is for (one or two lines), confirm the detected stack, and ask team-or-solo
plus any conventions worth encoding. Propose defaults from the assessment and the mining so the
user confirms rather than types essays. Every question carries one sentence on why the answer
matters.

### 4. Propose the plan

One visible plan, then per-item approval. Draw from three sources, in this order:

- **Toolshed core**, from the eigenwise-toolshed marketplace. Every piece is independent and
  opt-in: they compose, but none of them requires another, and a project that wants one of them
  is not signing up for the rest. You will have to explain each one you propose, so lead with
  what it does for this user before the reason it fits, and ground that reason in the project
  purpose and their attribution history. Say "probably not needed here" when it does not fit.

  - `codebase-mapper` keeps a set of small docs under `.claude/.codebase-info/` describing the
    architecture, entry points, modules, and conventions, and injects the index at session start
    so Claude begins oriented instead of re-exploring the tree every time. It refreshes itself
    from the diff as the code changes. Worth it for any real codebase; pointless for an empty
    scaffold until there is code to map.
  - `live-rules` holds project rules as Markdown that gets re-injected exactly when it applies:
    every prompt for the always-on ones, or right before Claude edits a file matching a glob.
    That is the difference from CLAUDE.md, which is always in context whether or not it is
    relevant. Edits take effect on the next prompt, no restart. Worth it anywhere the user has
    conventions they keep having to repeat.
  - `sidequest` is the delegation system, not just a ticket tracker, and the routing and
    executor half is where the value is. Tickets are the input; what it does with them is
    classify each into a category, route that category to a concrete model and effort level so
    nobody hand-picks a model per task, dispatch it to a token-gated executor in an isolated git
    worktree, gate the result on a verify command the ticket carries, and integrate it back. It
    also captures side issues mentioned mid-task, and runs a live self-hosted Kanban dashboard
    spanning every project. Recommend it where work is recurring and delegable; a project that
    just wants a list of TODOs does not need any of this. Non-Claude routes (GPT, Grok) need
    `model-gateway`, and without it routing still works across Claude models.
  - `observability` is local, metadata-only telemetry: a bundled observer records session, tool,
    and subagent lifecycle events into SQLite on the machine, an optional statusline shows live
    context and usage, and an OpenTelemetry Collector can forward redacted signals to Grafana or
    another sink. Prompts, responses, code, tool inputs and results, credentials, and
    environment values are never stored, and every sink beyond local SQLite is opt-in. Propose
    it only when the user wants to see where their tokens and time go; its
    `enable-project-telemetry` skill owns that whole flow from consent through verification, so
    hand off rather than wiring it yourself.
  - `model-gateway` puts the user's existing ChatGPT/Codex and Grok subscription models in
    Claude Code's `/model` picker through a local gateway, no API keys. It is what makes
    sidequest's non-Claude routes possible. User-scope and global.
  - `workbench` is the caretaker: it updates Toolshed plugins, guards against a session running
    stale plugin code, and answers health questions through `/toolshed-doctor`. User-scope and
    global.

  `model-gateway` and `workbench` install once for the whole machine, so check their state and
  point at their own skills; never install them per-project.
- **Stack plugins**, from [references/stack-plugins.md](references/stack-plugins.md) plus the
  catalog (`node "${CLAUDE_PLUGIN_ROOT}/bin/quartermaster.js" catalog --query "<stack terms>"`).
  For LSP plugins, check the required binary is on PATH first; report a missing binary with its
  install hint, but never run a package manager yourself.
- **History-derived seeds**: permission allowlist entries from repeated global denial patterns
  that are safe for this stack (scoped rules only, never `Bash(*)`); starter live rules derived
  from recurring correction themes, using
  [references/rule-templates.md](references/rule-templates.md) as reference material to derive
  from, never copy (byte-identical output means it was copied; rewrite or drop it); the
  self-improvement rule from [references/self-improvement.md](references/self-improvement.md) on
  every workspace.

Default plugin installs to project scope so the config travels with the repo. Show the full
install and write list (every file path, including any `~/.claude/settings.json` change) and get
approval before touching anything.

### 5. Install, then write, then reload

Order matters: plugins install first, workspace artifacts that depend on them second, and
nothing that needs a plugin loaded happens until after one reload.

- Install approved plugins with `claude plugin install <name>@<marketplace> --scope project`.
- Write the approved artifacts: live rules under `.claude/live-rules/rules/*.md` via live-rules'
  documented atomic format (or its `add-rule` skill after reload), `permissions.allow` entries
  in `.claude/settings.json`, a structure note for greenfield projects per
  [references/structure-notes.md](references/structure-notes.md), and optionally a lightweight
  CLAUDE.md seeded through the built-in `/init`.
- Then stop once: ask the user to run `/reload-plugins` (or restart) and tell you to continue.
  Do not pretend the plugins are loaded and barrel on in the same turn.

### 6. Verify against reality

After the reload: `claude plugin list --json` confirms every selected plugin is installed and
enabled at its requested scope. Then verify each piece is actually usable, not just present:
build the codebase map via `map-codebase` (skip for not-a-codebase), confirm live-rules content
is visibly injected in your context, bring up the sidequest board if selected, and check each
LSP responds. If model-gateway is installed but unwired, point at its skill rather than wiring
it yourself. Fix what fails and re-verify; report what you confirmed, concretely.

### 7. Record and hand over

Record every decision, applied and rejected, exactly as the retro skill does:

```
node "${CLAUDE_PLUGIN_ROOT}/bin/quartermaster.js" decisions add --project "${CLAUDE_PROJECT_DIR}" \
  --title "<short title>" --fingerprint "<kind>:<slug>" --status applied|rejected --kind <kind>
```

Close with what they got, a short next-actions list using only what was installed and verified,
a reminder to commit `.claude/`, and a pointer to
https://eigenwise.github.io/eigenwise-toolshed/getting-started/ naming the page for each plugin
just installed. The quartermaster retro will pick it up from here: once real sessions exist, it
asks what would make the user's goals easier to reach and whether this setup is earning its place.

## Guidelines

- Orchestrate, don't reinvent: the other plugins' skills own their domains. You write the glue
  and the sequencing.
- Less is the feature. A project with four well-chosen, verified pieces beats fifteen
  speculative ones; the retro catches what was missed.
- Never clobber. Merge into existing `.claude/` files; a user's rules and config survive.
- No stack is baked into this skill. Stack specifics live in the reference catalog; extend it
  when you meet a stack it does not cover.
- Rules and notes say where config lives, never actual credential values.

## Success criteria

- [ ] Project assessed (new/existing, codebase/not, existing config read and respected)
- [ ] Cross-project mining ran and visibly informed the recommendations
- [ ] Full install and write list shown and approved before any change
- [ ] Plugins installed before dependent artifacts; exactly one reload requested
- [ ] Every installed piece verified usable after reload, not assumed
- [ ] Every decision recorded with a fingerprint, rejections included

## References

- `references/stack-plugins.md` - stack to plugins/marketplaces/LSP catalog
- `references/rule-templates.md` - craft-baseline and stack rule reference material
- `references/self-improvement.md` - the self-improvement live rule every workspace gets
- `references/structure-notes.md` - structure notes, mostly for greenfield
- `references/clean-code-principles.md` - optional digest for the guidelines-pointer rule
