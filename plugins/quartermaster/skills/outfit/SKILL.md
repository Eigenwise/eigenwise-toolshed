---
name: outfit
description: Transform this project into a working Claude Code workspace, new or existing. Checks what is already there, installs and configures what is missing, and takes a new project on to its first build. Use for workspace setup, project bootstrap, or choosing which Toolshed plugins, rules and permissions fit.
argument-hint: "[what the project is for]"
---

# Outfit

Transform this project into a working setup, empty or years old. Check first, then ask only what you could not find out. Every write is a proposal the human approves, recorded as a change with its prior bytes, so any of it can be undone.

## 1. Explore before asking

Without the human:

- Read the project root: its manifests, `CLAUDE.md`, `.claude/`, `.sidequest/`, the test and build commands. An existing `.claude/` gets added to, never overwritten.
- Look for written coding guidelines: `.claude/rules/` files, a contributing or style page, linter and formatter config.
- Decide: real codebase or not (a notes vault skips the map), solo or team (git authors, a committed `.claude/settings.json`).
- An empty folder is a new project. Ask what it is for. Rules, permissions and the map wait until there is code. No git repository yet: `references/new-folder.md` first.
- Mine the history:

  ```sh
  node "${CLAUDE_PLUGIN_ROOT}/scripts/mine.mjs" "${CLAUDE_PROJECT_DIR}"
  ```

  `humanSessions: 0` means no history yet.
- List what is installed: `claude plugin list --json`.
- Look for the older version and for installs made by hand:

  ```sh
  node "${CLAUDE_PLUGIN_ROOT}/scripts/upgrade-scan.mjs" --project "${CLAUDE_PROJECT_DIR}" --line
  ```

  ```sh
  node "${CLAUDE_PLUGIN_ROOT}/scripts/found-installed.mjs" --project "${CLAUDE_PROJECT_DIR}"
  ```

  Silence from both means neither applies. `references/existing-project.md` says what to do with what they print.

## 2. Present what you found

A few lines: what the project is, what it has, and what that settled.

## 3. One section at a time

Follow `references/grilling.md`. Skip what exploration settled.

**Toolshed plugins.** Recommend only what fits; leave installed ones alone.

- `sidequest`: the work board, the planning with the person and the model routing the rest of the flow runs on. If it is missing, say you will install it, unless they decline. Its routing defaults work; `/sidequest:setup` changes them.
- `codebase-mapper`: a codebase map as path-scoped rules. Fits any real codebase.
- `live-rules`: write and audit `.claude/rules/`. Fits conventions people keep repeating.

Install with `claude plugin install <name>@toolshed-next --scope local` in a team project until the human says the team adopts it, `--scope project` in a solo one. Never shorten the command: `@toolshed-next` is part of the name, and a bare name or another marketplace installs a different plugin. The permission prompt is the human's approval. For a same-named plugin already installed from elsewhere, and for a team's own map, rules and workflow, follow `references/existing-project.md`.

If you installed anything, ask the human to run `/reload-plugins` and to say when it is done (after a `git init` here, a restart instead: `references/new-folder.md`). That is the one stop; the next sections use those plugins.

**Rules.** Propose a rule in `.claude/rules/` only for a convention the code or history shows. Give it `paths:` frontmatter so it loads only where it applies. Derive it from this project, never from a template. With live-rules installed, hand the writing to its skill.

Written guidelines found: say so in one line and offer nothing. None found: offer one item, writing them down from what the code already does (naming, error handling, test layout, comments) as short checkable sentences, nothing the code does not do. Show the draft; on a yes store them as rules files with `paths`. They load with no plugin: when `live-rules` is not installed, say once in one line what it would add (an audit of the rules, and new rules written from a "from now on" remark) and never require it. Quartermaster only sets this up, the review checks. In a team repository follow `references/existing-project.md`.

**Permission allow rules.** Only for a command the history shows approved by hand again and again and never denied. Approvals under an auto or bypass mode prove nothing. Personal rules go in `.claude/settings.local.json`, team rules in `.claude/settings.json`. Never propose a rule that:

- runs arbitrary code: an interpreter or wrapper anywhere in it (`node`, `python`, `bash`, `sh`, `pwsh`, `powershell`, `cmd`, `npx`, `uvx`, `env`, `sudo`, `xargs`, `eval`, `exec`, `ssh`, `source`, `nohup`, `timeout`, `watch` and kin)
- is a bare executable (`Bash(curl:*)` also allows `curl -T ~/.ssh/id_rsa`) or a bare multi-purpose tool (`git`, `docker`, `npm`, `gh`, `kubectl`, `cargo`, `dotnet`, `terraform`, `aws`)
- covers a destructive sibling: `git push`, `reset`, `clean`, `branch`, `rm`, `checkout` or `restore`, any `docker`, `podman` or `kubectl` subcommand, `npm publish`, `unpublish` or `version`
- comes from a command that was ever destructive, even once (`rm`, `del`, `Remove-Item`, `kill`, `drop`, `truncate`, `--force`, `reset --hard`, `find -delete`)
- starts with a shell keyword (`for`, `while`, `if`, `case`, `function`) or `(` or `{`
- was cut from a compound command (`;`, `&`, `|`, `<`, `>`, a newline, a trailing backslash)
- has a variable, a command substitution (`$(`, `${`, a backtick) or a glob in its argument
- names a path-invoked or quoted executable, a plugin cache path or a session scratchpad
- keeps a second word that is a file, path or generated id instead of a subcommand
- is a PowerShell rule

When nothing passes, say so.

**Codebase map.** For a real codebase with codebase-mapper installed, offer to build the map with its skill.

## 4. Write, one approved item at a time

For each approved item, through `mcp__quartermaster__proposal`:

1. `operation: create` with `kind` (`plugin`, `routing`, `rule`, `permission` or `docs`), `target`, `evidence` (fingerprints), `expect`, `baseline` and a `body` holding the exact diff or command and the rollback.
2. `operation: decide`, `decision: approve`, because the human just said yes to it here.
3. `operation: record-change` with `id` and `files`, every file the change touches, BEFORE writing. A plugin install touches `.claude/settings.json`, or `settings.local.json` at local scope.
4. Make exactly that change, then `operation: update` with `status: applied`, and run its check.

If the tool is missing (mod not loaded), keep the same records by hand in the layout the `apply` skill describes.

Nothing is written into the home directory unless the human asks by name.

## 5. Activate and verify

Check: `claude plugin list --json` shows each piece enabled at the scope you installed it at, the files you wrote are there, and any promised check passes. Report what you confirmed and what you could not. Only a new, empty project then loads Sidequest's `sidequest:plan` skill. An existing project is done here.