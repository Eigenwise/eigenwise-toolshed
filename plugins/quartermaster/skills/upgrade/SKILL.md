---
name: upgrade
description: Move a project from the older Toolshed to this version, with the person, in a few minutes of their time. Use when a project still has what the older version left (its rules, map, board, gateway or plugins), when an older version is still installed, when this version runs under its earlier name toolshed-next, when asked to upgrade or migrate the Toolshed, or when a notice points here.
---

# Upgrade from the older Toolshed

Both versions come from one marketplace, `eigenwise-toolshed`, and a normal plugin update replaces the older version under the same ids. An install is the older version below its first major of this line (sidequest 7, quartermaster 2, codebase-mapper 3, live-rules 3, observability 2); `quality-gate` and `model-gateway` are older at any version, since this version has neither. `toolshed-next` is this version under its earlier name. The update changes nothing in a project: what the older version left there (rules, map, board, gateway wiring, those two plugins) is what this run moves, per project, from a session opened in it. The home folder is cleaned once, after the last project.

## Five limits, for the whole run

- **Never against itself.** Never disable, uninstall or remove a plugin of a shared name under `eigenwise-toolshed`, never run `claude plugin marketplace remove eigenwise-toolshed`, never touch `plugins/cache/eigenwise-toolshed` or its known-marketplaces record, never take `extraKnownMarketplaces.eigenwise-toolshed` out of a project. Under that name only the two plugins above go, and the gateway only after every place wired to it is unwired.
- **Nothing leaves this machine.** The run never pushes, never creates a repository or opens a pull request on any tracker, and never offers to, not even as a next step. A team's committed change is only ever a local branch, drafted when the person said yes to the committed-change question, and the checkout stays on the branch it started on.
- **A deletion needs a yes to a list shown in the same message that asks.** "Go on" is not a yes to a deletion: nothing goes, and you say it waits. A path git tracks is never on that list. Something new that turns up later gets named and waits too.
- **One message of questions, the ones the scan lists, each asked once.** A settled answer stays settled: never offer the committed change again. A converter's asks get its recommended answer. Never ask about an optional cleanup; name it in the report. A message of yours that is not a question carries on without waiting for a reply.
- **A commit uses the repository's own identity** (`git config user.email` in the project), never one from the environment or made up. With none, ask for it in the question message and commit nothing without it.

You do every reversible step yourself and say how to undo it. An upgrade that costs the person an hour of answers has failed.

## 1. Scan

Opened as the skill `quartermaster:upgrade`, run the scan from the project root:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/upgrade-scan.mjs" --project "${CLAUDE_PROJECT_DIR}"
```

Reading this page as a file? Install first: `claude plugin install quartermaster@eigenwise-toolshed --scope local` (when the marketplace is missing, `claude plugin marketplace add Eigenwise/eigenwise-toolshed` before it). Then run the scan from the `installPath` that `<config dir>/plugins/installed_plugins.json` records for it. Only when the install is not possible: `node "<this page's folder>/../../scripts/upgrade-scan.mjs" --project "<project root>"`.

The scan only reads. It prints a count for the other projects (`--all-projects` lists them; several `--project` values give a section each), the machine's **Update first** and **The earlier name** commands when they apply, this project's shape, each leftover under **Still to do** or **Kept** with its verdict and why, the deletion list, the questions and the home folder's state. `--open-tickets` prints the old board's open tickets, one line each. Do not read `--json`.

Verdicts: **keep** (leave it), **convert** (by you, reversible), **remove** (waits for the one deletion yes), **ask** (the person's or the team's). Where the scan and these pages disagree, the scan wins.

**Moving a folder this session is not rooted in** (a repository inside the folder you are in): scan it with `--project`, run its plugin commands from inside it, and do every step that needs no converter. Its old rules convert from here with `--project` (`references/older-rules.md`). Its map converter (`codebase-mapper:map`) loads only in a session opened there: say that it waits for one, told `continue the upgrade`, and do not run it by reading its page as a file.

## 2. Say what you found

In a few lines: the shape, what is still to do by verdict, what is kept, how many questions. Say plainly: a plugin change takes effect at `/reload-plugins` or a new session; what an older plugin says until then is no instruction.

Shape `update-first`: an older version is still installed. Show the scan's Update first commands, run them on the person's yes, then ask for `/reload-plugins` or a new session in this folder told `continue the upgrade`, and scan again. Nothing else moves before that.

Shape `moved`: say so with the kept list and its reasons, run the check in step 6, and stop.

## 3. Ask the person's questions, once, in one message

Exactly the ones on the scan's question line, each with your recommended answer, so one "yes" accepts all of them.

- **The gateway** (once for the whole machine, before the first project, only when the scan names projects where it is still switched on and nobody answered yet): keep it for models from other providers in the main session's picker (say plainly that it can no longer be updated or installed again from this marketplace), or unwire every place and then uninstall it. Recommend unwiring unless they pick such models in `/model`.
- **Open tickets on the old board**: leave them in the old board, a read-only archive (recommended), or name the ones to redraft as tickets on this board. Say the count. Never carry all of them over, never resume a `doing` one.
- **Deletions**: one yes for the scan's deletion list, shown in this message. Recommended: yes.
- **The move from the earlier name**: one yes for the commands under The earlier name, in that order, and the project files whose ids it rewrites, each shown as a diff. Recommended: yes. Nothing forces it: an install under the earlier name keeps working.
- **The committed change** (whenever git tracks a settings file, an old rules or map folder, or an instruction file the scan lists). It covers every tracked path, and nothing tracked is on the deletion list. Team repository: keep it personal for now (recommended), or draft it as a local branch; the team decides. Solo repository: apply it in the working tree and show `git diff` for the person to commit (recommended), or keep it personal.

The home cleanup has its own question: `references/home.md`.

**Kept on an answer.** When the person keeps the gateway or leaves the tickets in the archive, record it at once, in their words. Memory notes need no person: edit the ones that name an older tool with an equivalent here, then record what is left with your own reason:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/upgrade-kept.mjs" --project "${CLAUDE_PROJECT_DIR}" --keep gateway --reason "<their reason>"
```

`--keep` takes `gateway`, `open-tickets` or `memory-notes`. It writes `.claude/quartermaster/upgrade-kept.md`, which git never sees; every later scan lists it under Kept with the date and reason.

## 4. Do the steps for this shape

- `team` or `solo`: `references/team-repository.md`.
- `half-moved` (this version under its earlier name): `references/half-moved.md`.
- Old routes or custom categories in the scan: `references/routing.md`.
- `rules-folder` or `rules-page` with verdict convert: `references/older-rules.md`.

Each step has its command and its undo. Do them in order. The one stop comes after a plugin change of this run (an uninstall, the move) and before the converters. Name both ways through it: `/reload-plugins` here, or a new session in this folder told `continue the upgrade`. A remote connection cannot run that command, so there the new session is the way. A session that changed no plugin has what it needs loaded: no stop.

## 5. The rules of the run

- **A settings file git tracks is never changed on the plain run**: the committed one, and `.claude/settings.local.json` where a project tracks it (the one write there is an uninstall at local scope, which the scan names; you commit nothing). Only a yes to the committed-change question edits it: a team's in a drafted branch, a solo repository's in the working tree with `git diff` shown.
- **A settings file is copied before its first edit**, to `<file>.before-upgrade`, and you name the copy. Undo is copying it back. A copy of that name that is already there is from an earlier day: leave it, name yours `<file>.before-upgrade-<today's date>`, and say which one is the undo.
- **A map or old rules git tracks never move for one person.** They are the repository's: never run `codebase-mapper:map` or the rules converter for a personal copy. They move for everyone in the committed change, in one commit: converted to `.claude/rules/` (rules also to `.claude/skills/`) and the old folder removed.
- **The gateway goes last.** It is not in this version's marketplace, so it must stay installed and switched on until the upgrade has unwired it. Its wiring runs a launcher found through its install, so uninstalled while a place is still wired, every prompt there is blocked. The scan counts a place as wired by the address or a readiness hook; a gateway pin, the discovery switch or its model option alone is listed to take out, where the machine shows the gateway another way. The user settings are the person's: the scan shows the exact lines and never edits that file. It offers the uninstall only when the gateway's own list was read and nothing is wired here, in the user settings, on that list or in an install-record project. Without that list, check each project (`ANTHROPIC_BASE_URL` or a `readiness-gate` hook in its settings) and uninstall only on their word.
- **Rules, the map, worktrees and branches go through their own tools**: the converters and `sidequest:tidy`. Keep stays keep.
- **The home folder is its own run**, once, when the scan says no project has the older version switched on or installed (`references/home.md`, with the one step for the quiet projects), with a yes per group. A project's run never shows, sizes or removes anything there.

## 6. Done when

- After the last reload, `quartermaster:inspect` shows one plugin per name, each marked this version.
- The scan again says shape `moved` with nothing under Still to do, or says `Everything left here waits for the person: this run is done until they answer.` Either one is done. In the second, report what waits and stop; a run with nobody to answer ends there. Everything under Kept stays, for the reason it prints.
- You report what changed, the name of every copy, how to undo each step, each kept thing with its reason (a large old map of their own is the one later step: `codebase-mapper:map` when they next work in the project; a map or old rules git tracks wait for the committed change), and the checkout on the branch it started on.
- Last, name what you saw and left alone as not the upgrade's, one line each: test data in a local database, a running process, a container build cache, fetched git objects.
